import { app } from '@/app';
import { env } from '@/config/env';

app.listen({
  hostname: env.host,
  port: env.port,
});

console.log(`KUQuest API running at http://localhost:${env.port}`);