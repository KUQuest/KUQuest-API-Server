const parsePort = (value: string | undefined): number => {
  const port = Number(value ?? 5000);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }

  return port;
};

export const env = {
  nodeEnv: Bun.env.NODE_ENV ?? 'development',
  host: Bun.env.HOST ?? '0.0.0.0',
  port: parsePort(Bun.env.PORT),

  databaseUrl: Bun.env.DATABASE_URL,
  jwtAccessSecret: Bun.env.JWT_ACCESS_SECRET,
  jwtRefreshSecret: Bun.env.JWT_REFRESH_SECRET,
  xenditSecretKey: Bun.env.XENDIT_SECRET_KEY,
  xenditWebhookToken: Bun.env.XENDIT_WEBHOOK_TOKEN,
  cmsOrigin: Bun.env.CMS_ORIGIN,
} as const;
