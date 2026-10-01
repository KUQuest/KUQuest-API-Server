import postgres from 'postgres';

export const STAGING_DATABASE_RESET_CONFIRMATION =
  'RESET staging database WARNING wipe out whole database';

const databaseNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const systemDatabaseNames: Record<string, true> = {
  postgres: true,
  template0: true,
  template1: true,
};

type StagingResetEnvironment = {
  NODE_ENV?: string;
  DEPLOYMENT_ENV?: string;
  CONFIRM_STAGING_DATABASE_RESET?: string;
};

type DatabaseTarget = {
  databaseName: string;
  maintenanceDatabaseUrl: string;
};

export const validateStagingResetEnvironment = (environment: StagingResetEnvironment): void => {
  if (environment.NODE_ENV !== 'production' || environment.DEPLOYMENT_ENV !== 'staging') {
    throw new Error(
      'The staging database reset requires NODE_ENV=production and DEPLOYMENT_ENV=staging.'
    );
  }

  if (environment.CONFIRM_STAGING_DATABASE_RESET !== STAGING_DATABASE_RESET_CONFIRMATION) {
    throw new Error(
      `Set CONFIRM_STAGING_DATABASE_RESET="${STAGING_DATABASE_RESET_CONFIRMATION}" to reset the staging database.`
    );
  }
};

export const parseDatabaseTarget = (databaseUrl: string): DatabaseTarget => {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.');
  }

  if (parsedUrl.protocol !== 'postgres:' && parsedUrl.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use the postgres:// or postgresql:// scheme.');
  }

  const databaseName = decodeURIComponent(parsedUrl.pathname.slice(1));
  if (!databaseName || !databaseNamePattern.test(databaseName)) {
    throw new Error('DATABASE_URL must contain a simple PostgreSQL database name.');
  }
  if (systemDatabaseNames[databaseName]) {
    throw new Error('The reset command refuses to reset the PostgreSQL system database.');
  }

  const maintenanceUrl = new URL(parsedUrl);
  maintenanceUrl.pathname = '/postgres';

  return {
    databaseName,
    maintenanceDatabaseUrl: maintenanceUrl.toString(),
  };
};

const quoteIdentifier = (value: string): string => `"${value}"`;

const runCommand = async (command: string): Promise<void> => {
  const child = Bun.spawn(['bun', 'run', command], {
    env: process.env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command} failed with exit code ${exitCode}.`);
};

const resetDatabase = async (target: DatabaseTarget): Promise<void> => {
  const adminSql = postgres(target.maintenanceDatabaseUrl, {
    max: 1,
    prepare: false,
  });

  try {
    await adminSql`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = ${target.databaseName}
        AND pid <> pg_backend_pid()
    `;
    await adminSql.unsafe(`DROP DATABASE ${quoteIdentifier(target.databaseName)}`);
    await adminSql.unsafe(`CREATE DATABASE ${quoteIdentifier(target.databaseName)}`);
  } finally {
    await adminSql.end();
  }
};

const main = async (): Promise<void> => {
  validateStagingResetEnvironment(process.env);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for the staging database reset.');

  const target = parseDatabaseTarget(databaseUrl);
  await resetDatabase(target);

  await runCommand('db:migrate');
  await runCommand('db:verify-migration-journal');
  await runCommand('db:seed-staging');
  await runCommand('db:verify-staging-seed');

  console.log(`Staging database ${target.databaseName} was reset and seeded.`);
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Staging database reset failed.');
    process.exitCode = 1;
  }
}
