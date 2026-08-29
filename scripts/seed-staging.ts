export {};

const seedCommands = [
  'db:seed-admin',
  'db:seed-demo-users',
  'db:seed-frontend-demo',
  'db:seed-finance-test',
] as const;

const runSeed = async (command: string): Promise<void> => {
  const child = Bun.spawn(['bun', 'run', command], {
    env: process.env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command} failed with exit code ${exitCode}.`);
};

const main = async (): Promise<void> => {
  if (process.env.STAGING_FINANCE_SEED_ENABLED !== 'true') {
    throw new Error('Set STAGING_FINANCE_SEED_ENABLED=true to load the staging seed data.');
  }
  const isDevelopmentSeed =
    process.env.NODE_ENV === 'development' && process.env.DEPLOYMENT_ENV === 'development';
  const isStagingSeed =
    process.env.NODE_ENV === 'production' && process.env.DEPLOYMENT_ENV === 'staging';
  if (!isDevelopmentSeed && !isStagingSeed) {
    throw new Error(
      'The staging seed is allowed only in development/development or production/staging.',
    );
  }

  for (const command of seedCommands) {
    // The seeds are separate processes because each supported seed owns its database connection.
    // eslint-disable-next-line no-await-in-loop
    await runSeed(command);
  }
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Staging seed failed.');
  process.exitCode = 1;
}
