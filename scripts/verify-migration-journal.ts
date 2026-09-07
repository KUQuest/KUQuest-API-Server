import { sql } from '@/database/client';

import { readMigrationFiles } from 'drizzle-orm/migrator';

type AppliedMigration = {
  id: number;
  hash: string;
  createdAt: string;
};

const main = async (): Promise<void> => {
  const expectedMigrations = readMigrationFiles({ migrationsFolder: './drizzle' });
  const appliedMigrations = await sql<AppliedMigration[]>`
    SELECT id, hash, created_at AS "createdAt"
    FROM drizzle.__drizzle_migrations
    ORDER BY id ASC
  `;

  if (appliedMigrations.length !== expectedMigrations.length) {
    throw new Error(
      `Migration journal has ${appliedMigrations.length} entries; expected ${expectedMigrations.length}.`,
    );
  }

  const mismatch = expectedMigrations.find((migration, index) => {
    const applied = appliedMigrations[index];
    return !applied || applied.hash !== migration.hash || Number(applied.createdAt) !== migration.folderMillis;
  });

  if (mismatch) {
    throw new Error('Migration journal does not match the committed migration chain.');
  }

  console.log(`Verified ${expectedMigrations.length} committed migrations.`);
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Migration journal verification failed.');
  process.exitCode = 1;
} finally {
  await sql.end();
}
