import { expect, test } from 'bun:test';

const resetScript = `${import.meta.dir}/../../scripts/reset-local-database.ts`;

const runReset = (env: Record<string, string>) => Bun.spawnSync(
  ['bun', resetScript],
  {
    env: { ...process.env, ...env },
    stderr: 'pipe',
    stdout: 'pipe',
  },
);

test('local database reset refuses a non-development deployment', () => {
  const result = runReset({
    NODE_ENV: 'production',
    DEPLOYMENT_ENV: 'staging',
    CONFIRM_LOCAL_DB_RESET: 'RESET local database',
  });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;

  expect(result.exitCode).toBe(1);
  expect(output).toContain('requires NODE_ENV=development and DEPLOYMENT_ENV=development');
});

test('local database reset refuses a missing destructive confirmation', () => {
  const result = runReset({
    NODE_ENV: 'development',
    DEPLOYMENT_ENV: 'development',
    CONFIRM_LOCAL_DB_RESET: 'yes',
  });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;

  expect(result.exitCode).toBe(1);
  expect(output).toContain('Set CONFIRM_LOCAL_DB_RESET="RESET local database"');
});

test('local database reset refuses a non-local database URL', () => {
  const result = runReset({
    NODE_ENV: 'development',
    DEPLOYMENT_ENV: 'development',
    CONFIRM_LOCAL_DB_RESET: 'RESET local database',
    DATABASE_URL: 'postgresql://kuquest:secret@example.invalid:5432/kuquest',
  });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;

  expect(result.exitCode).toBe(1);
  expect(output).toContain('accepts only a localhost DATABASE_URL');
});
