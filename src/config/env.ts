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
  s3Endpoint: process.env.S3_ENDPOINT,
  s3Region: process.env.S3_REGION,
  s3Bucket: process.env.S3_BUCKET,
  s3AccessKeyId: process.env.S3_ACCESS_KEY_ID,
  s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
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
  S3_ENDPOINT: env.s3Endpoint,
  S3_REGION: env.s3Region,
  S3_BUCKET: env.s3Bucket,
  S3_ACCESS_KEY_ID: env.s3AccessKeyId,
  S3_SECRET_ACCESS_KEY: env.s3SecretAccessKey,
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
};
