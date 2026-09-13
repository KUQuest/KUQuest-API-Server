import { defaultLocalDatabaseUrl } from '@/config/default-database-url';

import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';

import postgres from 'postgres';

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
  if (!isDuplicate) throw error;
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
