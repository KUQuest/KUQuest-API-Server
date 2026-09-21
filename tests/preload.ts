import { defaultLocalDatabaseUrl } from '@/config/default-database-url';

import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';

import postgres from 'postgres';

// The image tests presign links with these five values. A worktree holds no
// `.env`, because git does not track it, so an unset value turns every image
// response into a 503 and the cause stays hidden in a long test log.
const storageKeys = [
  'S3_ACCESS_KEY_ID',
  'S3_BUCKET',
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_SECRET_ACCESS_KEY',
];
const missingStorageKeys = storageKeys.filter((key) => !process.env[key]);
if (missingStorageKeys.length > 0) {
  throw new Error(
    `These tests need object storage. Set these variables: ${missingStorageKeys.join(', ')}. Copy the \`.env\` file of the main checkout into this worktree, then run the tests again.`
  );
}

// Worktree directory names may hold characters a PostgreSQL identifier cannot
// (CI checks out KUQuest-API-Server), so sanitize; fall back when nothing survives.
const worktreeName =
  basename(process.cwd())
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_') || 'worktree';
const testDatabaseName = `kuquest_test_${worktreeName}`;

const baseUrl = process.env.DATABASE_URL || defaultLocalDatabaseUrl;

const serverUrl = new URL(baseUrl);
serverUrl.pathname = '/postgres';

const testUrl = new URL(baseUrl);
testUrl.pathname = `/${testDatabaseName}`;

// Create the worktree database when absent. Two first runs can race, so an
// existing database counts as success.
const server = postgres(serverUrl.toString(), { prepare: false, max: 1 });
try {
  await server.unsafe(`CREATE DATABASE "${testDatabaseName}"`);
} catch (error) {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  const isDuplicate =
    code === '42P04' || (error instanceof Error && error.message.includes('already exists'));
  if (!isDuplicate) {
    const isConnectionFailure =
      (typeof code === 'string' && (code.startsWith('08') || code.startsWith('E'))) ||
      (error instanceof Error && /connect/i.test(error.message));
    if (isConnectionFailure) {
      throw new Error(
        `These tests need PostgreSQL and could not connect to ${serverUrl.host}. Start it with \`podman start kuquest-postgres\` (or \`podman compose up -d\`), then run \`bun run db:migrate\`.`,
        { cause: error }
      );
    }
    throw error;
  }
} finally {
  await server.end();
}

process.env.DATABASE_URL = testUrl.toString();

// Run the whole migration script, not only the inner migrate() call. The script
// also moves the Payout Destination legacy columns to their final shape.
const migration = spawnSync(process.execPath, ['scripts/migrate.ts'], {
  env: process.env,
  stdio: 'inherit',
});
if (migration.status !== 0) {
  throw new Error(`Migration script failed with exit code ${migration.status ?? 'unknown'}.`);
}

console.log(`[test] Using per-worktree database ${testDatabaseName}`);
