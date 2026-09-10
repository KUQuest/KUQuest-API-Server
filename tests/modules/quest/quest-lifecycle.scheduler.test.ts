import { describe, expect, it } from 'bun:test';

import { createQuestLifecycleScheduler } from '@/modules/quest/quest-lifecycle.scheduler';

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('Quest lifecycle scheduler', () => {
  it('runs one immediate sweep and schedules later sweeps', async () => {
    const tasks: (() => void)[] = [];
    let runs = 0;
    const scheduler = createQuestLifecycleScheduler({
      run: async () => {
        runs += 1;
      },
      intervalMs: 10_000,
      schedule: (task) => {
        tasks.push(task);
        return () => {};
      },
    });

    scheduler.start();
    await flush();
    expect(runs).toBe(1);
    expect(tasks).toHaveLength(1);

    tasks[0]!();
    await flush();
    expect(runs).toBe(2);
  });

  it('does not overlap sweeps and reports a rejected sweep', async () => {
    const tasks: (() => void)[] = [];
    const errors: unknown[] = [];
    let releaseFirst!: () => void;
    let runs = 0;
    const scheduler = createQuestLifecycleScheduler({
      run: () => {
        runs += 1;
        if (runs === 1)
          return new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        return Promise.reject(new Error('sweep failed'));
      },
      schedule: (task) => {
        tasks.push(task);
        return () => {};
      },
      onError: (error) => errors.push(error),
    });

    scheduler.start();
    await flush();
    tasks[0]!();
    await flush();
    expect(runs).toBe(1);

    releaseFirst();
    await flush();
    tasks[0]!();
    await flush();
    expect(runs).toBe(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
  });
});
