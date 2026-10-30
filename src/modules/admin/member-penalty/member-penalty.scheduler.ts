import { processExpiredMemberBanWalletFreezes } from './member-penalty.service';

const intervalMs = 10_000;

export const startMemberBanWalletFreezeScheduler = () => {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await processExpiredMemberBanWalletFreezes();
    } catch (error) {
      console.error('Member Ban Wallet freeze scheduler failed', error);
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  return () => clearInterval(timer);
};
