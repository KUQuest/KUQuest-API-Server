import { app } from '@/app';
import { env, validateRuntimeEnv } from '@/config/env';
import { startPayoutScheduler } from '@/modules/payout';
import { ensureInitialMoneyPolicy } from '@/modules/wallet';
import { startQuestLifecycleScheduler } from '@/modules/quest/quest-lifecycle.scheduler';
import { runQuestLifecycleWorker } from '@/modules/quest/quest-lifecycle.worker';

validateRuntimeEnv();

await ensureInitialMoneyPolicy();

app.listen({
  hostname: env.host,
  port: env.port,
});

startQuestLifecycleScheduler({ run: () => runQuestLifecycleWorker() });
startPayoutScheduler();

console.log(`KUQuest API running at http://localhost:${env.port}`);
