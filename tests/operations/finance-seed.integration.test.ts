import { expect, test } from 'bun:test';

const financeSeedScript = `${import.meta.dir}/../../scripts/seed-finance-test.ts`;
const stagingSeedScript = `${import.meta.dir}/../../scripts/seed-staging.ts`;

test('finance seed refuses to run without the explicit safety flag', () => {
  const result = Bun.spawnSync(
    ['bun', financeSeedScript],
    {
      env: {
        ...process.env,
        NODE_ENV: 'development',
        DEPLOYMENT_ENV: 'development',
        XENDIT_SECRET_KEY: 'xnd_development_test-only',
      },
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;

  expect(result.exitCode).toBe(1);
  expect(output).toContain('Set STAGING_FINANCE_SEED_ENABLED=true');
});

test('finance seed refuses a production Xendit key', () => {
  const result = Bun.spawnSync(
    ['bun', financeSeedScript],
    {
      env: {
        ...process.env,
        NODE_ENV: 'development',
        DEPLOYMENT_ENV: 'development',
        STAGING_FINANCE_SEED_ENABLED: 'true',
        XENDIT_SECRET_KEY: 'xnd_production_test-only',
      },
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;

  expect(result.exitCode).toBe(1);
  expect(output).toContain('requires an Xendit Development API key');
});

test('staging seed refuses a production deployment before running child seeds', () => {
  const result = Bun.spawnSync(
    ['bun', stagingSeedScript],
    {
      env: {
        ...process.env,
        NODE_ENV: 'production',
        DEPLOYMENT_ENV: 'production',
        STAGING_FINANCE_SEED_ENABLED: 'true',
      },
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;

  expect(result.exitCode).toBe(1);
  expect(output).toContain('allowed only in development or staging');
});
