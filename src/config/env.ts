const parsePort = (value: string | undefined): number => {
  const port = Number(value ?? 5000);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }

  return port;
};

export const assertAuthSecretLength = (name: string, value: string): void => {
  if (value.length < 32) {
    throw new Error(`${name} must be at least 32 characters long`);
  }
};

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  host: process.env.HOST ?? '0.0.0.0',
  port: parsePort(process.env.PORT),

  databaseUrl: process.env.DATABASE_URL,
  betterAuthUrl: process.env.BETTER_AUTH_URL,
  betterAuthSecret: process.env.BETTER_AUTH_SECRET,
  adminBetterAuthSecret: process.env.ADMIN_BETTER_AUTH_SECRET,
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
  termsUrl: process.env.TERMS_URL,
  privacyUrl: process.env.PRIVACY_URL,
  dataUsageUrl: process.env.DATA_USAGE_URL,
  contactUsUrl: process.env.CONTACT_US_URL,
} as const;

const requiredRuntimeVariables = {
  DATABASE_URL: env.databaseUrl,
  BETTER_AUTH_URL: env.betterAuthUrl,
  BETTER_AUTH_SECRET: env.betterAuthSecret,
  ADMIN_BETTER_AUTH_SECRET: env.adminBetterAuthSecret,
  GOOGLE_CLIENT_ID: env.googleClientId,
  GOOGLE_CLIENT_SECRET: env.googleClientSecret,
  S3_ENDPOINT: env.s3Endpoint,
  S3_REGION: env.s3Region,
  S3_BUCKET: env.s3Bucket,
  S3_ACCESS_KEY_ID: env.s3AccessKeyId,
  S3_SECRET_ACCESS_KEY: env.s3SecretAccessKey,
  TERMS_URL: env.termsUrl,
  PRIVACY_URL: env.privacyUrl,
  DATA_USAGE_URL: env.dataUsageUrl,
  CONTACT_US_URL: env.contactUsUrl,
} as const;

export const validateRuntimeEnv = (): void => {
  const missing = Object.entries(requiredRuntimeVariables)
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (env.betterAuthSecret) {
    assertAuthSecretLength('BETTER_AUTH_SECRET', env.betterAuthSecret);
  }

  if (env.adminBetterAuthSecret) {
    assertAuthSecretLength('ADMIN_BETTER_AUTH_SECRET', env.adminBetterAuthSecret);
  }
};
