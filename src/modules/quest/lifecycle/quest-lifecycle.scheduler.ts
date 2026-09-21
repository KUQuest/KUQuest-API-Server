const defaultIntervalMs = 10_000;

type Schedule = (task: () => void, intervalMs: number) => () => void;

export type QuestLifecycleSchedulerOptions = {
  intervalMs?: number;
  run: () => Promise<unknown>;
  schedule?: Schedule;
  onError?: (error: unknown) => void;
};

const scheduleWithInterval: Schedule = (task, intervalMs) => {
  const timer = setInterval(task, intervalMs);
  return () => clearInterval(timer);
};

export const createQuestLifecycleScheduler = ({
  intervalMs = defaultIntervalMs,
  run,
  schedule = scheduleWithInterval,
  onError = (error) => console.error('Quest lifecycle scheduler failed', error),
}: QuestLifecycleSchedulerOptions) => {
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

export const startQuestLifecycleScheduler = (options: QuestLifecycleSchedulerOptions) =>
  createQuestLifecycleScheduler(options).start();
