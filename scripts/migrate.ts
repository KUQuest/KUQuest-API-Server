import { createPayoutDestinationEncryption } from '@/modules/payout-destination/payout-destination.crypto';

import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

const connectionString =
  process.env.DATABASE_URL ||
  'postgresql://kuquest:kuquest-local-only@localhost:5432/kuquest';

const sql = postgres(connectionString, { prepare: false });
const db = drizzle(sql);

const accountLegacyColumns = ['account_number', 'routing_value'] as const;
const payoutLegacyColumns = ['destination_account_number', 'destination_routing_value'] as const;

type LegacySchemaState = {
  account: boolean;
  payout: boolean;
};

type LegacySecretRow = {
  id: string;
  accountNumber: string;
  routingValue: string;
};

const hasExpectedColumns = (actual: string[], expected: readonly string[]): boolean =>
  actual.length === expected.length && expected.every((column) => actual.includes(column));

const readLegacySchemaState = async (): Promise<LegacySchemaState> => {
  const columns = await sql<{ tableName: string; columnName: string }[]>`
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
  const accountColumns = columns
    .filter(({ tableName }) => tableName === 'payment_payout_accounts')
    .map(({ columnName }) => columnName);
  const payoutColumns = columns
    .filter(({ tableName }) => tableName === 'payment_payouts')
    .map(({ columnName }) => columnName);

  if (
    (accountColumns.length > 0 && !hasExpectedColumns(accountColumns, accountLegacyColumns)) ||
    (payoutColumns.length > 0 && !hasExpectedColumns(payoutColumns, payoutLegacyColumns)) ||
    (accountColumns.length > 0) !== (payoutColumns.length > 0)
  ) {
    throw new Error('Legacy Payout Destination schema is incomplete.');
  }

  return {
    account: accountColumns.length > 0,
    payout: payoutColumns.length > 0,
  };
};

const readLegacyRowCounts = async (): Promise<{ accounts: number; payouts: number }> => {
  const [accounts, payouts] = await Promise.all([
    sql<{ count: number }[]>`SELECT count(*)::int AS count FROM payment_payout_accounts`,
    sql<{ count: number }[]>`SELECT count(*)::int AS count FROM payment_payouts`,
  ]);

  return {
    accounts: Number(accounts[0]?.count ?? 0),
    payouts: Number(payouts[0]?.count ?? 0),
  };
};

const validateLegacyData = async (): Promise<void> => {
  const [invalid] = await sql<{ invalid: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM payment_payout_accounts
      WHERE recipient_type <> 'SELF'
        OR account_country <> 'TH'
        OR account_currency <> 'THB'
        OR routing_type NOT IN ('BANK_ACCOUNT', 'PROMPTPAY')
        OR account_number IS NULL
        OR routing_value IS NULL
    ) AS invalid
  `;

  if (invalid?.invalid) {
    throw new Error('Legacy Payout Destination data is not supported.');
  }
};

const validateEncryptionKey = (): void => {
  createPayoutDestinationEncryption().encrypt('migration-key-check');
};

const finalizeLegacySecrets = async (): Promise<void> => {
  const legacy = await readLegacySchemaState();
  if (!legacy.account && !legacy.payout) return;

  await sql.begin(async (transaction) => {
    await transaction`
      LOCK TABLE payment_payout_accounts, payment_payouts IN ACCESS EXCLUSIVE MODE
    `;

    const accounts = await transaction<LegacySecretRow[]>`
      SELECT
        id,
        account_number AS "accountNumber",
        routing_value AS "routingValue"
      FROM payment_payout_accounts
    `;
    const payouts = await transaction<LegacySecretRow[]>`
      SELECT
        id,
        destination_account_number AS "accountNumber",
        destination_routing_value AS "routingValue"
      FROM payment_payouts
    `;
    const encryption = accounts.length > 0 || payouts.length > 0
      ? createPayoutDestinationEncryption()
      : undefined;

    if (encryption) {
      const encryptedAccounts = accounts.map((row) => ({
        id: row.id,
        accountNumber: encryption.encrypt(row.accountNumber),
        routingValue: encryption.encrypt(row.routingValue),
      }));
      const encryptedPayouts = payouts.map((row) => ({
        id: row.id,
        accountNumber: encryption.encrypt(row.accountNumber),
        routingValue: encryption.encrypt(row.routingValue),
      }));

      await Promise.all(encryptedAccounts.map((row) => transaction`
        UPDATE payment_payout_accounts
        SET
          account_number_key_version = ${row.accountNumber.keyVersion},
          account_number_nonce = ${row.accountNumber.nonce},
          account_number_ciphertext = ${row.accountNumber.ciphertext},
          account_number_auth_tag = ${row.accountNumber.authTag},
          routing_value_key_version = ${row.routingValue.keyVersion},
          routing_value_nonce = ${row.routingValue.nonce},
          routing_value_ciphertext = ${row.routingValue.ciphertext},
          routing_value_auth_tag = ${row.routingValue.authTag}
        WHERE id = ${row.id}
      `));
      await Promise.all(encryptedPayouts.map((row) => transaction`
        UPDATE payment_payouts
        SET
          destination_account_number_key_version = ${row.accountNumber.keyVersion},
          destination_account_number_nonce = ${row.accountNumber.nonce},
          destination_account_number_ciphertext = ${row.accountNumber.ciphertext},
          destination_account_number_auth_tag = ${row.accountNumber.authTag},
          destination_routing_value_key_version = ${row.routingValue.keyVersion},
          destination_routing_value_nonce = ${row.routingValue.nonce},
          destination_routing_value_ciphertext = ${row.routingValue.ciphertext},
          destination_routing_value_auth_tag = ${row.routingValue.authTag}
        WHERE id = ${row.id}
      `));
    }

    await transaction`
      ALTER TABLE payment_payout_accounts
        ALTER COLUMN account_number_key_version SET NOT NULL,
        ALTER COLUMN account_number_nonce SET NOT NULL,
        ALTER COLUMN account_number_ciphertext SET NOT NULL,
        ALTER COLUMN account_number_auth_tag SET NOT NULL,
        ALTER COLUMN routing_value_key_version SET NOT NULL,
        ALTER COLUMN routing_value_nonce SET NOT NULL,
        ALTER COLUMN routing_value_ciphertext SET NOT NULL,
        ALTER COLUMN routing_value_auth_tag SET NOT NULL
    `;
    await transaction`
      ALTER TABLE payment_payouts
        ALTER COLUMN destination_account_number_key_version SET NOT NULL,
        ALTER COLUMN destination_account_number_nonce SET NOT NULL,
        ALTER COLUMN destination_account_number_ciphertext SET NOT NULL,
        ALTER COLUMN destination_account_number_auth_tag SET NOT NULL,
        ALTER COLUMN destination_routing_value_key_version SET NOT NULL,
        ALTER COLUMN destination_routing_value_nonce SET NOT NULL,
        ALTER COLUMN destination_routing_value_ciphertext SET NOT NULL,
        ALTER COLUMN destination_routing_value_auth_tag SET NOT NULL
    `;
    await transaction`
      ALTER TABLE payment_payout_accounts
        VALIDATE CONSTRAINT payment_payout_accounts_routing_type_check,
        VALIDATE CONSTRAINT payment_payout_accounts_recipient_type_check
    `;
    await transaction`ALTER TABLE payment_payout_accounts DROP COLUMN account_number`;
    await transaction`ALTER TABLE payment_payout_accounts DROP COLUMN routing_value`;
    await transaction`ALTER TABLE payment_payouts DROP COLUMN destination_account_number`;
    await transaction`ALTER TABLE payment_payouts DROP COLUMN destination_routing_value`;
  });
};

const main = async (): Promise<void> => {
  const legacy = await readLegacySchemaState();
  if (legacy.account || legacy.payout) {
    const counts = await readLegacyRowCounts();
    if (counts.accounts > 0 || counts.payouts > 0) {
      validateEncryptionKey();
      await validateLegacyData();
    }
  }

  await migrate(db, { migrationsFolder: './drizzle' });
  await finalizeLegacySecrets();
};

try {
  await main();
} catch (error) {
  if (error instanceof Error && error.message.includes('Payout Destination encryption key')) {
    console.error('Payout Destination migration failed: encryption key is unavailable.');
  } else {
    console.error('Payout Destination migration did not complete. Sensitive values were not written to output.');
  }
  process.exitCode = 1;
} finally {
  await sql.end();
}
