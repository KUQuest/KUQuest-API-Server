import { env } from '@/config/env';
import {
  topUpTestSimulationIsEnabled,
  uatSeedConfirmation,
} from '@/modules/top-up/top-up.test-mode.service';

import { afterEach, describe, expect, test } from 'bun:test';

import { createUatScenarioPlan } from '../../scripts/seed-uat-scenario';

const previous = {
  nodeEnv: env.nodeEnv,
  deploymentEnv: env.deploymentEnv,
  xenditSecretKey: env.xenditSecretKey,
};
const previousConfirmation = process.env.UAT_SEED_CONFIRM;

afterEach(() => {
  Object.assign(env, previous);
  if (previousConfirmation === undefined) delete process.env.UAT_SEED_CONFIRM;
  else process.env.UAT_SEED_CONFIRM = previousConfirmation;
});

describe('UAT Top-up simulation gate', () => {
  const uat = { nodeEnv: 'production', deploymentEnv: 'uat', xenditSecretKey: 'xnd_development_x' };

  test('stays closed for the running UAT API', () => {
    Object.assign(env, uat);
    delete process.env.UAT_SEED_CONFIRM;
    expect(topUpTestSimulationIsEnabled()).toBe(false);
  });

  test('opens only for a confirmed UAT seed process with a Development key', () => {
    Object.assign(env, uat);
    process.env.UAT_SEED_CONFIRM = uatSeedConfirmation;
    expect(topUpTestSimulationIsEnabled()).toBe(true);

    process.env.UAT_SEED_CONFIRM = 'yes';
    expect(topUpTestSimulationIsEnabled()).toBe(false);

    process.env.UAT_SEED_CONFIRM = uatSeedConfirmation;
    Object.assign(env, { xenditSecretKey: 'xnd_production_x' });
    expect(topUpTestSimulationIsEnabled()).toBe(false);
  });

  test('stays closed in production even with the confirmation', () => {
    Object.assign(env, { ...uat, deploymentEnv: 'production' });
    process.env.UAT_SEED_CONFIRM = uatSeedConfirmation;
    expect(topUpTestSimulationIsEnabled()).toBe(false);
  });
});

describe('UAT scenario plan', () => {
  const plan = createUatScenarioPlan();

  test('covers every Quest flow the Admin pages show', () => {
    const counts: Record<string, number> = {};
    for (const { flow } of plan) counts[flow] = (counts[flow] ?? 0) + 1;
    expect(plan).toHaveLength(58);
    expect(counts).toEqual({
      COMPLETED: 13,
      COMPLETED_GROUP: 3,
      COMPLETED_CANDIDATE: 3,
      COMPLETED_NO_PROOF: 2,
      FAILED_NOT_APPROVED: 4,
      FAILED_DUE: 2,
      CANCELLED: 4,
      PROOF_PENDING: 4,
      IN_PROGRESS: 4,
      ASSIGNED: 3,
      OPEN: 8,
      OPEN_CANDIDATES: 4,
      DRAFT: 4,
    });
  });

  test('never makes a Hirer work on their own Quest', () => {
    for (const quest of plan) {
      expect(quest.workers).not.toContain(quest.hirer);
      expect(quest.applicants).not.toContain(quest.hirer);
    }
  });

  test('gives each still-active Assignment its own Worker', () => {
    const activeWorkers = plan
      .filter(({ flow }) => ['ASSIGNED', 'IN_PROGRESS', 'PROOF_PENDING'].includes(flow))
      .flatMap(({ workers }) => workers);
    expect(new Set(activeWorkers).size).toBe(activeWorkers.length);
  });
});
