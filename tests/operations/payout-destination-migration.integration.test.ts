import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import {
  createPayoutDestinationEncryption,
  savePayoutDestination,
} from '@/modules/payout-destination';

import { expect, test } from 'bun:test';
import { join } from 'node:path';

const repositoryDirectory = join(import.meta.dir, '../..');
const migrationScript = join(repositoryDirectory, 'scripts/migrate.ts');
const encryptionKey = 'm'.repeat(32);
const encryption = createPayoutDestinationEncryption({
  activeKeyVersion: 'v1',
  keys: { v1: encryptionKey },
});

const legacySecretColumns = async () => sql<{ tableName: string; columnName: string }[]>`
  SELECT table_name AS "tableName", column_name AS "columnName"
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND (
      (table_name = 'payment_payout_accounts' AND column_name IN ('account_number', 'routing_value'))
      OR
      (table_name = 'payment_payouts' AND column_name IN ('destination_account_number', 'destination_routing_value'))
    )
  ORDER BY table_name, column_name
`;

test('migration backfill failure rolls back encrypted writes and legacy cleanup', async () => {
  const existingLegacyColumns = await legacySecretColumns();
  const existingColumnNames = new Set(existingLegacyColumns.map(({ tableName, columnName }) => `${tableName}.${columnName}`));
  const expectedLegacyColumns = [
    'payment_payout_accounts.account_number',
    'payment_payout_accounts.routing_value',
    'payment_payouts.destination_account_number',
    'payment_payouts.destination_routing_value',
  ];
  if (existingLegacyColumns.length > 0 && expectedLegacyColumns.some((column) => !existingColumnNames.has(column))) {
    throw new Error('Legacy Payout Destination columns are incomplete for the migration test.');
  }
  const addedLegacyColumns = existingLegacyColumns.length === 0;

  const studentId = crypto.randomUUID();
  await db.insert(authUser).values({
    id: studentId,
    email: `${studentId}@ku.th`,
    firstName: 'Migration',
    lastName: 'Test',
  });
  const destination = await savePayoutDestination({
    principalUserId: studentId,
    givenName: 'Migration',
    surname: 'Test',
    relationship: 'SELF',
    bankCode: 'SCB',
    accountNumber: '1234567890',
    accountHolderName: 'Migration Test',
    routingType: 'BANK_ACCOUNT',
    routingValue: '1234567890',
  }, encryption);

  if (addedLegacyColumns) {
    await sql`ALTER TABLE payment_payout_accounts
      ADD COLUMN account_number text,
      ADD COLUMN routing_value text`;
    await sql`ALTER TABLE payment_payouts
      ADD COLUMN destination_account_number text,
      ADD COLUMN destination_routing_value text`;
  }
  await sql`UPDATE payment_payout_accounts
    SET account_number = '1234567890', routing_value = '1234567890'
    WHERE id = ${destination.id}`;

  const [before] = Array.from(await sql<{
    accountNumberKeyVersion: string;
    accountNumberNonce: string;
    accountNumberCiphertext: string;
    accountNumberAuthTag: string;
  }[]>`SELECT
    account_number_key_version AS "accountNumberKeyVersion",
    account_number_nonce AS "accountNumberNonce",
    account_number_ciphertext AS "accountNumberCiphertext",
    account_number_auth_tag AS "accountNumberAuthTag"
    FROM payment_payout_accounts
    WHERE id = ${destination.id}`);

  await sql`CREATE TABLE be114_migration_backfill_failure_targets (id uuid PRIMARY KEY)`;
  await sql`INSERT INTO be114_migration_backfill_failure_targets (id) VALUES (${destination.id})`;
  await sql`CREATE OR REPLACE FUNCTION be114_migration_backfill_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM be114_migration_backfill_failure_targets WHERE id = OLD.id) THEN
        RAISE EXCEPTION 'BE-114 forced migration backfill failure';
      END IF;
      RETURN NEW;
    END;
  $$`;
  await sql`CREATE TRIGGER be114_migration_backfill_failure_trigger
    BEFORE UPDATE ON payment_payout_accounts
    FOR EACH ROW
    EXECUTE FUNCTION be114_migration_backfill_failure()`;

  try {
    const result = Bun.spawnSync(['bun', migrationScript], {
      cwd: repositoryDirectory,
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL,
        PAYOUT_DESTINATION_ENCRYPTION_KEY: encryptionKey,
        PAYOUT_DESTINATION_ENCRYPTION_KEY_VERSION: 'v1',
      },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;

    expect(result.exitCode).toBe(1);
    expect(output).not.toContain('1234567890');
    expect(Array.from(await sql<{ accountNumber: string }[]>`SELECT account_number AS "accountNumber"
      FROM payment_payout_accounts
      WHERE id = ${destination.id}`)).toEqual([
      { accountNumber: '1234567890' },
    ]);
    expect(Array.from(await sql<{
      accountNumberKeyVersion: string;
      accountNumberNonce: string;
      accountNumberCiphertext: string;
      accountNumberAuthTag: string;
    }[]>`SELECT
      account_number_key_version AS "accountNumberKeyVersion",
      account_number_nonce AS "accountNumberNonce",
      account_number_ciphertext AS "accountNumberCiphertext",
      account_number_auth_tag AS "accountNumberAuthTag"
      FROM payment_payout_accounts
      WHERE id = ${destination.id}`)).toEqual([before]);
    expect(Array.from(await sql<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'payment_payout_accounts'
        AND column_name IN ('account_number', 'routing_value')
      ORDER BY column_name
    `)).toEqual([
      { column_name: 'account_number' },
      { column_name: 'routing_value' },
    ]);
  } finally {
    await sql`DROP TRIGGER IF EXISTS be114_migration_backfill_failure_trigger ON payment_payout_accounts`;
    await sql`DROP FUNCTION IF EXISTS be114_migration_backfill_failure()`;
    await sql`DROP TABLE IF EXISTS be114_migration_backfill_failure_targets`;
    if (addedLegacyColumns) {
      await sql`ALTER TABLE payment_payout_accounts
        DROP COLUMN account_number,
        DROP COLUMN routing_value`;
      await sql`ALTER TABLE payment_payouts
        DROP COLUMN destination_account_number,
        DROP COLUMN destination_routing_value`;
    } else {
      await sql`DELETE FROM payment_payout_accounts WHERE id = ${destination.id}`;
      await sql`DELETE FROM auth_user WHERE id = ${studentId}`;
    }
  }
});
