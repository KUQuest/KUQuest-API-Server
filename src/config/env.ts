const parsePort = (value: string | undefined): number => {
  const port = Number(value ?? 5000);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }

  return port;
};

export const env = {
  nodeEnv: process.env.NODE_ENV,
  host: process.env.HOST ?? '0.0.0.0',
  port: parsePort(process.env.PORT),

  databaseUrl: process.env.DATABASE_URL,
  betterAuthUrl: process.env.BETTER_AUTH_URL,
  betterAuthSecret: process.env.BETTER_AUTH_SECRET,
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  xenditSecretKey: process.env.XENDIT_SECRET_KEY,
  xenditWebhookToken:
    process.env.XENDIT_WEBHOOK_TOKEN ??
    process.env.XENDIT_WEBHOOK_VERIFICATION_TOKEN,
  publicApiUrl: process.env.PUBLIC_API_URL,
  cmsOrigin: process.env.CMS_ORIGIN,
} as const;

type RuntimeEnvironment = typeof env;

export const validateRuntimeEnv = (
  configuration: RuntimeEnvironment = env,
): void => {
  const requiredRuntimeVariables = {
    NODE_ENV: configuration.nodeEnv,
    DATABASE_URL: configuration.databaseUrl,
    BETTER_AUTH_URL: configuration.betterAuthUrl,
    BETTER_AUTH_SECRET: configuration.betterAuthSecret,
    GOOGLE_CLIENT_ID: configuration.googleClientId,
    GOOGLE_CLIENT_SECRET: configuration.googleClientSecret,
  } as const;
  const missing = Object.entries(requiredRuntimeVariables)
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (!['development', 'test', 'production'].includes(configuration.nodeEnv!)) {
    throw new Error('NODE_ENV must be development, test, or production');
  }

  if (configuration.betterAuthSecret && configuration.betterAuthSecret.length < 32) {
    throw new Error('BETTER_AUTH_SECRET must be at least 32 characters long');
  }

  if (
    configuration.nodeEnv === 'production' &&
    configuration.betterAuthSecret === 'local-development-only-secret-change-me'
  ) {
    throw new Error('The development BETTER_AUTH_SECRET cannot be used in production');
  }

  if (configuration.nodeEnv === 'production') {
    const knownDevelopmentValues = [
      configuration.databaseUrl?.includes('app-local-only@'),
      configuration.googleClientId === 'docker-test-client-id',
      configuration.googleClientSecret === 'docker-test-client-secret',
    ];
    if (knownDevelopmentValues.some(Boolean)) {
      throw new Error('Repository development credentials cannot be used in production');
    }
  }
};
