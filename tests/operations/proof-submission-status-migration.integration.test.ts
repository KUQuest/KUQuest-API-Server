import { sql } from '@/database/client';

import { expect, test } from 'bun:test';
import { join } from 'node:path';

const migrationPath = join(
  import.meta.dir,
  '../../drizzle/20260910014123_validate_dispute_history.sql',
);

test('Proof status migration normalizes legacy rows before applying the canonical constraint', async () => {
  const migration = await Bun.file(migrationPath).text();
  const statements = migration
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);
  const normalizationEnd = statements.findIndex((statement) =>
    statement.includes(
      'CREATE OR REPLACE FUNCTION wallet_assert_funding_reservation_history',
    ),
  );
  if (normalizationEnd < 0) {
    throw new Error('Proof status migration normalization statements are missing.');
  }

  const normalizationStatements = statements.slice(0, normalizationEnd);
  const schemaName = `proof_status_migration_${crypto.randomUUID().replaceAll('-', '')}`;

  await sql.begin(async (transaction) => {
    await transaction.unsafe(`CREATE SCHEMA "${schemaName}"`);
    await transaction.unsafe(`SET LOCAL search_path TO "${schemaName}"`);
    await transaction.unsafe(`
      CREATE TABLE quest (
        quest_status text NOT NULL,
        failed_at timestamptz,
        updated_at timestamptz NOT NULL
      )
    `);
    await transaction.unsafe(`
      CREATE TABLE proof_submission (
        id integer PRIMARY KEY,
        submission_status varchar(32) NOT NULL,
        CONSTRAINT proof_submission_status_check
          CHECK (submission_status IN ('PROOF_PENDING', 'PROOF_APPROVED', 'PROOF_REJECTED', 'PROOF_AUTO_APPROVED'))
      )
    `);
    await transaction.unsafe(`
      INSERT INTO quest (quest_status, updated_at)
      VALUES ('QUEST_DISPUTED', now())
    `);
    await transaction.unsafe(`
      INSERT INTO proof_submission (id, submission_status)
      VALUES (1, 'PROOF_AUTO_APPROVED'), (2, 'PROOF_REJECTED')
    `);

    for (const statement of normalizationStatements) {
      // Migration statements must execute sequentially in their source order.
      // eslint-disable-next-line no-await-in-loop
      await transaction.unsafe(statement);
    }

    const proofRows = await transaction.unsafe<{
      id: number;
      submissionStatus: string;
    }[]>(
      'SELECT id, submission_status AS "submissionStatus" FROM proof_submission ORDER BY id',
    );
    const [questRow] = await transaction.unsafe<{
      failedAt: string | null;
      questStatus: string;
    }[]>(
      'SELECT quest_status AS "questStatus", failed_at AS "failedAt" FROM quest',
    );
    const [constraint] = await transaction.unsafe<{ definition: string }[]>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conname = 'proof_submission_status_check'
         AND conrelid = 'proof_submission'::regclass`,
    );

    expect([...proofRows]).toEqual([
      { id: 1, submissionStatus: 'PROOF_APPROVED' },
      { id: 2, submissionStatus: 'PROOF_NOT_APPROVED' },
    ]);
    expect(questRow?.questStatus).toBe('QUEST_FAILED');
    expect(questRow?.failedAt).not.toBeNull();
    expect(constraint?.definition).toContain('PROOF_NOT_APPROVED');

    await transaction.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
  });
});
