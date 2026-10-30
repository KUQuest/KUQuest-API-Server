import { processPendingPushDeliveries } from './push.service';

const intervalMs = 15_000;

export const startPushScheduler = () => {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await processPendingPushDeliveries();
    } catch (error) {
      console.error('Push delivery worker failed', error);
    } finally {
      running = false;
    }
  };

  void tick();
  setInterval(() => void tick(), intervalMs);
};
