import { sql } from '@/database/client';

const localDatabaseHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

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

const main = async (): Promise<void> => {
  if (process.env.NODE_ENV !== 'development' || process.env.DEPLOYMENT_ENV !== 'development') {
    throw new Error('The local database reset requires NODE_ENV=development and DEPLOYMENT_ENV=development.');
  }
  if (process.env.CONFIRM_LOCAL_DB_RESET !== 'RESET local database') {
    throw new Error('Set CONFIRM_LOCAL_DB_RESET="RESET local database" to reset the local database.');
  }

  const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://kuquest:kuquest-local-only@localhost:5432/kuquest';
  const parsedUrl = new URL(databaseUrl);
  if (!localDatabaseHosts.has(parsedUrl.hostname)) {
    throw new Error('The local database reset accepts only a localhost DATABASE_URL.');
  }

  await sql`DROP SCHEMA public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await sql`CREATE SCHEMA IF NOT EXISTS drizzle`;
  await sql`
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `;
  await sql`TRUNCATE TABLE drizzle.__drizzle_migrations`;
  await sql.end();

  await runCommand('db:migrate');
  await runCommand('db:verify-migration-journal');
  console.log('Local database reset and migration completed.');
  console.log('Load demo and finance data with STAGING_FINANCE_SEED_ENABLED=true bun run db:seed-staging.');
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Local database reset failed.');
  process.exitCode = 1;
}
