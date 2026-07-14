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
import {
  createDevelopmentActorSessionResolver,
  createDevelopmentTestRoute,
  createMoneyDiagnosticsRoute,
  PostgresDevelopmentTestRepository,
} from './modules/dev-test';
import { createJobRoute } from './modules/jobs/job.route';
import type { JobRepository } from './modules/jobs/job.types';
import { PostgresJobRepository } from './modules/jobs/postgres-job.repository';
import { createMoneyRoute } from './modules/money/money.route';
import type { MoneyRepository } from './modules/money/money.types';
import { PostgresMoneyRepository } from './modules/money/postgres-money.repository';
import { createXenditWebhookRoute } from './modules/money/webhook.route';
import { createPaymentsRoute } from './modules/payments/payments.route';
import type { PaymentsRepository } from './modules/payments/payments.types';
import { PostgresPaymentsRepository } from './modules/payments/postgres-payments.repository';
import { HttpXenditClient } from './modules/payments/xendit.client';

import { corsPlugin } from './plugins/cors';
import { errorHandlerPlugin } from './plugins/error-handler';
import { openapiPlugin } from './plugins/openapi';

export interface AppDependencies {
  moneyRepository?: MoneyRepository;
  sessionResolver?: SessionResolver;
  trustedOrigins?: readonly string[];
  xenditWebhookToken?: string;
  paymentsRepository?: PaymentsRepository;
  jobRepository?: JobRepository;
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
    env.betterAuthUrl || `http://localhost:${env.port}`,
  ];
  const paymentsRepository = dependencies.paymentsRepository ??
    new PostgresPaymentsRepository(sql, new HttpXenditClient(env.xenditSecretKey));
  const jobRepository = dependencies.jobRepository ?? new PostgresJobRepository(sql);
  const rootSessionResolver = dependencies.sessionResolver ?? resolveBetterAuthSession;
  const developmentEnabled = env.nodeEnv !== 'production';
  const developmentRepository = new PostgresDevelopmentTestRepository();
  const effectiveSessionResolver = dependencies.sessionResolver ??
    createDevelopmentActorSessionResolver(
      developmentRepository,
      rootSessionResolver,
      { enabled: developmentEnabled },
    );
  let webhookDrainTimer: ReturnType<typeof setInterval> | undefined;
  const drainWebhooks = async () => {
    try {
      await paymentsRepository.processStoredWebhooks();
    } catch (error) {
      console.error('Durable webhook drain failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  };

  return new Elysia({ name: 'kuquest-api' })
    .onStart(() => {
      void drainWebhooks();
      webhookDrainTimer = setInterval(() => void drainWebhooks(), 5_000);
      webhookDrainTimer.unref();
    })
    .onStop(() => {
      if (webhookDrainTimer) clearInterval(webhookDrainTimer);
    })
    .use(errorHandlerPlugin)
    .use(corsPlugin)
    .use(authPlugin)
    .use(openapiPlugin)
    .use(developmentEnabled ? authTestRoute : new Elysia())
    .use(healthRoute)
    .use(
      createDevelopmentTestRoute({
        enabled: developmentEnabled,
        repository: developmentRepository,
        rootSessionResolver,
        trustedOrigins,
        secureCookie: env.nodeEnv === 'production',
      }),
    )
    .use(createMoneyDiagnosticsRoute(sql,effectiveSessionResolver,developmentEnabled))
    .use(
      createMoneyRoute(
        moneyRepository,
        effectiveSessionResolver,
        trustedOrigins,
      ),
    )
    .use(
      createPaymentsRoute(
        paymentsRepository,
        effectiveSessionResolver,
        trustedOrigins,
        env.nodeEnv !== 'production',
      ),
    )
    .use(
      createJobRoute(
        jobRepository,
        effectiveSessionResolver,
        trustedOrigins,
      ),
    )
    .use(
      createXenditWebhookRoute(
        moneyRepository,
        dependencies.xenditWebhookToken ?? defaultWebhookToken(),
        dependencies.moneyRepository && !dependencies.paymentsRepository
          ? undefined
          : drainWebhooks,
      ),
    );
};

export const app = createApp();
