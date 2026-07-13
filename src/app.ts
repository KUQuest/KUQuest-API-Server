import { Elysia } from 'elysia';
import { env } from './config/env';
import { sql } from './database/client';
import {
  authPlugin,
  authTestRoute,
  resolveBetterAuthSession,
  type SessionResolver,
} from './modules/auth';
import { healthRoute } from './modules/health/health.route';
import { createMoneyRoute } from './modules/money/money.route';
import type { MoneyRepository } from './modules/money/money.types';
import { PostgresMoneyRepository } from './modules/money/postgres-money.repository';
import { createXenditWebhookRoute } from './modules/money/webhook.route';

import { corsPlugin } from './plugins/cors';
import { errorHandlerPlugin } from './plugins/error-handler';
import { openapiPlugin } from './plugins/openapi';

export interface AppDependencies {
  moneyRepository?: MoneyRepository;
  sessionResolver?: SessionResolver;
  trustedOrigins?: readonly string[];
  xenditWebhookToken?: string;
}

const defaultWebhookToken = (): string | undefined => {
  if (env.xenditWebhookToken) return env.xenditWebhookToken;
  if (env.nodeEnv === 'production') {
    throw new Error('XENDIT_WEBHOOK_TOKEN is required in production.');
  }
  return undefined;
};

export const createApp = (dependencies: AppDependencies = {}) => {
  const moneyRepository =
    dependencies.moneyRepository ?? new PostgresMoneyRepository(sql);
  const trustedOrigins = dependencies.trustedOrigins ?? [
    env.cmsOrigin || 'http://localhost:3000',
  ];

  return new Elysia({ name: 'kuquest-api' })
    .use(errorHandlerPlugin)
    .use(corsPlugin)
    .use(authPlugin)
    .use(openapiPlugin)
    .use(authTestRoute)
    .use(healthRoute)
    .use(
      createMoneyRoute(
        moneyRepository,
        dependencies.sessionResolver ?? resolveBetterAuthSession,
        trustedOrigins,
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
