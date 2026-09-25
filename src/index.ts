import { app } from '@/app';
import { env, validateRuntimeEnv } from '@/config/env';
import { startPayoutScheduler } from '@/modules/payout';
import { startPushScheduler } from '@/modules/push';
import { ensureInitialMoneyPolicy } from '@/modules/wallet';
import { startQuestLifecycleScheduler, runQuestLifecycleWorker } from '@/modules/quest/lifecycle';

validateRuntimeEnv();

await ensureInitialMoneyPolicy();

app.listen({
  hostname: env.host,
  port: env.port,
});

startQuestLifecycleScheduler({ run: () => runQuestLifecycleWorker() });
startPayoutScheduler();
startPushScheduler();

console.log(`KUQuest API running at http://localhost:${env.port}`);
