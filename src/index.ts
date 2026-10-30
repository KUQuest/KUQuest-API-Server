import { app } from '@/app';
import { env, validateRuntimeEnv } from '@/config/env';
import { ensureAdminUpdateListener } from '@/modules/admin';
import { startMemberBanWalletFreezeScheduler } from '@/modules/admin/member-penalty';
import { startPayoutScheduler } from '@/modules/payout';
import { startPushScheduler } from '@/modules/push';
import { ensureInitialMoneyPolicy } from '@/modules/wallet';
import { startQuestLifecycleScheduler, runQuestLifecycleWorker } from '@/modules/quest/lifecycle';

validateRuntimeEnv();

await ensureInitialMoneyPolicy();
await ensureAdminUpdateListener();

app.listen({
  hostname: env.host,
  port: env.port,
});

startQuestLifecycleScheduler({ run: () => runQuestLifecycleWorker() });
startMemberBanWalletFreezeScheduler();
startPayoutScheduler();
startPushScheduler();

console.log(`KUQuest API running at http://localhost:${env.port}`);
