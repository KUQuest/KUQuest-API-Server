import { processApprovedPayouts } from './payout.service';

const defaultIntervalMs = 15_000;

type Schedule = (task: () => void, intervalMs: number) => () => void;

export type PayoutSchedulerOptions = {
  intervalMs?: number;
  run?: () => Promise<unknown>;
  schedule?: Schedule;
  onError?: (error: unknown) => void;
};

const scheduleWithInterval: Schedule = (task, intervalMs) => {
  const timer = setInterval(task, intervalMs);
  return () => clearInterval(timer);
};

export const createPayoutScheduler = ({
  intervalMs = defaultIntervalMs,
  run = () => processApprovedPayouts(),
  schedule = scheduleWithInterval,
  onError = (error) => console.error('Payout scheduler failed', error),
}: PayoutSchedulerOptions = {}) => {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await run();
    } catch (error) {
      onError(error);
    } finally {
      running = false;
    }
  };

  return {
    start: () => {
      void tick();
      return schedule(() => void tick(), intervalMs);
    },
  };
};

export const startPayoutScheduler = (options?: PayoutSchedulerOptions) =>
  createPayoutScheduler(options).start();
