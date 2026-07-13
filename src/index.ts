import { app } from '@/app';
import { env, validateRuntimeEnv } from '@/config/env';

validateRuntimeEnv();

app.listen({
  hostname: env.host,
  port: env.port,
});

console.log(`KUQuest API running at http://localhost:${env.port}`);
