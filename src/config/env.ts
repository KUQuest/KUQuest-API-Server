const parsePort = (value: string | undefined): number => {
  const port = Number(value ?? 5000);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }

  return port;
};

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  host: process.env.HOST ?? '0.0.0.0',
  port: parsePort(process.env.PORT),

  databaseUrl: process.env.DATABASE_URL,
  betterAuthUrl: process.env.BETTER_AUTH_URL,
  betterAuthSecret: process.env.BETTER_AUTH_SECRET,
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  xenditSecretKey: process.env.XENDIT_SECRET_KEY,
  xenditWebhookToken: process.env.XENDIT_WEBHOOK_TOKEN,
  cmsOrigin: process.env.CMS_ORIGIN,
} as const;

const requiredRuntimeVariables = {
  DATABASE_URL: env.databaseUrl,
  BETTER_AUTH_URL: env.betterAuthUrl,
  BETTER_AUTH_SECRET: env.betterAuthSecret,
  GOOGLE_CLIENT_ID: env.googleClientId,
  GOOGLE_CLIENT_SECRET: env.googleClientSecret,
} as const;

export const validateRuntimeEnv = (): void => {
  const missing = Object.entries(requiredRuntimeVariables)
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (env.betterAuthSecret && env.betterAuthSecret.length < 32) {
    throw new Error('BETTER_AUTH_SECRET must be at least 32 characters long');
  }

  if (
    env.nodeEnv === 'production' &&
    env.betterAuthSecret === 'local-development-only-secret-change-me'
  ) {
    throw new Error('The development BETTER_AUTH_SECRET cannot be used in production');
  }

  if (env.nodeEnv === 'production') {
    const knownDevelopmentValues = [
      env.databaseUrl?.includes('app-local-only@'),
      env.googleClientId === 'docker-test-client-id',
      env.googleClientSecret === 'docker-test-client-secret',
    ];
    if (knownDevelopmentValues.some(Boolean)) {
      throw new Error('Repository development credentials cannot be used in production');
    }
  }
};
