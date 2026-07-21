import { describe, expect, it } from 'bun:test';

import { env, validateRuntimeEnv } from '@/config/env';

const validEnvironment = {
  ...env,
  nodeEnv: 'test',
  databaseUrl: 'postgresql://test@localhost/kuquest',
  betterAuthUrl: 'http://localhost:5000',
  betterAuthSecret: 'test-secret-with-at-least-32-characters',
  googleClientId: 'test-client-id',
  googleClientSecret: 'test-client-secret',
};

describe('runtime environment validation', () => {
  it('requires NODE_ENV instead of silently enabling development behavior', () => {
    expect(() =>
      validateRuntimeEnv({ ...validEnvironment, nodeEnv: undefined }),
    ).toThrow('Missing required environment variables: NODE_ENV');
  });

  it('accepts only explicit runtime modes', () => {
    expect(() =>
      validateRuntimeEnv({ ...validEnvironment, nodeEnv: 'staging' }),
    ).toThrow('NODE_ENV must be development, test, or production');
  });

  it('accepts a complete test environment', () => {
    expect(() => validateRuntimeEnv(validEnvironment)).not.toThrow();
  });
});
