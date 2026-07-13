import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { SQL } from 'bun';

const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required to run migrations.');

const database = new SQL(databaseUrl);
const connection = await database.reserve();
const migrationsDirectory = resolve(import.meta.dir, '../../migrations');

try {
  await connection`
    SELECT pg_advisory_lock(hashtext('kuquest_schema_migrations'))
  `;

  await connection`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith('.sql'))
    .toSorted();

  // Migrations must run in lexical order and commit one at a time.
  for (const file of files) {
    // oxlint-disable-next-line no-await-in-loop
    const [applied] = await connection`
      SELECT name FROM schema_migrations WHERE name = ${file}
    `;
    if (applied) continue;

    const path = resolve(migrationsDirectory, file);
    // oxlint-disable-next-line no-await-in-loop
    const source = await Bun.file(path).text();
    // oxlint-disable-next-line no-await-in-loop
    await connection.begin(async (transaction) => {
      await transaction.unsafe(source);
      await transaction`
        INSERT INTO schema_migrations (name) VALUES (${file})
      `;
    });
    console.log(`Applied migration ${file}`);
  }
} finally {
  await connection`
    SELECT pg_advisory_unlock(hashtext('kuquest_schema_migrations'))
  `;
  connection.release();
  await database.close();
}
