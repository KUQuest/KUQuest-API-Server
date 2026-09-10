import { app } from '@/app';
import { env, validateRuntimeEnv } from '@/config/env';
import { startQuestLifecycleScheduler } from '@/modules/quest/quest-lifecycle.scheduler';
import { runQuestLifecycleWorker } from '@/modules/quest/quest-lifecycle.worker';

validateRuntimeEnv();

app.listen({
  hostname: env.host,
  port: env.port,
});

startQuestLifecycleScheduler({ run: () => runQuestLifecycleWorker() });

console.log(`KUQuest API running at http://localhost:${env.port}`);
