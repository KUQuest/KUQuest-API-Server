import { SQL } from 'bun';
import { Elysia } from 'elysia';

import { env } from './config/env';
import { healthRoute } from './modules/health/health.route';
import { createMoneyRoute } from './modules/money/money.route';
import type { MoneyRepository } from './modules/money/money.types';
import { PostgresMoneyRepository } from './modules/money/postgres-money.repository';
import { UnavailableMoneyRepository } from './modules/money/unavailable-money.repository';
import { createXenditWebhookRoute } from './modules/money/webhook.route';
import { errorHandlerPlugin } from './plugins/error-handler';
import { openapiPlugin } from './plugins/openapi';

interface AppDependencies {
  moneyRepository?: MoneyRepository;
  jwtAccessSecret?: string;
  xenditWebhookToken?: string;
}

const defaultMoneyRepository = (): MoneyRepository => {
  if (env.databaseUrl) {
    return new PostgresMoneyRepository(new SQL(env.databaseUrl));
  }
  if (env.nodeEnv === 'production') {
    throw new Error('DATABASE_URL is required in production.');
  }
  return new UnavailableMoneyRepository();
};

const defaultJwtSecret = (): string => {
  if (env.jwtAccessSecret) return env.jwtAccessSecret;
  if (env.nodeEnv === 'production') {
    throw new Error('JWT_ACCESS_SECRET is required in production.');
  }
  return 'development-only-jwt-secret-change-before-production';
};

const defaultWebhookToken = (): string | undefined => {
  if (env.xenditWebhookToken) return env.xenditWebhookToken;
  if (env.nodeEnv === 'production') {
    throw new Error(
      'XENDIT_WEBHOOK_VERIFICATION_TOKEN is required in production.',
    );
  }
  return undefined;
};

export const createApp = (dependencies: AppDependencies = {}) => {
  const moneyRepository =
    dependencies.moneyRepository ?? defaultMoneyRepository();

  return new Elysia({ name: 'kuquest-api' })
    .use(errorHandlerPlugin)
    .use(openapiPlugin)
    .get('/', () => 'Hello Elysia', {
      detail: {
        tags: ['General'],
        summary: 'API root',
        description: 'Returns a basic response from the KUQuest API.',
        operationId: 'getApiRoot',
      },
    })
    .use(healthRoute)
    .use(
      createMoneyRoute(
        moneyRepository,
        dependencies.jwtAccessSecret ?? defaultJwtSecret(),
      ),
    )
    .use(
      createXenditWebhookRoute(
        moneyRepository,
        dependencies.xenditWebhookToken ?? defaultWebhookToken(),
      ),
    );
};

export const app = createApp();
