import { isFinanceTestRuntime } from '@/config/env';

import { describe, expect, it } from 'bun:test';

describe('Finance test runtime policy', () => {
  it.each([
    ['development', 'development', true],
    ['development', 'staging', true],
    ['production', 'staging', true],
    ['production', 'production', false],
    ['test', 'staging', false],
  ])('handles NODE_ENV=%s and DEPLOYMENT_ENV=%s', (nodeEnv, deploymentEnv, expected) => {
    expect(isFinanceTestRuntime(nodeEnv, deploymentEnv)).toBe(expected);
  });
});
