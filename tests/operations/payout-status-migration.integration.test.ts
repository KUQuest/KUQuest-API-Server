import { sql } from '@/database/client';

import { expect, test } from 'bun:test';
import { join } from 'node:path';

const migrationPath = join(
  import.meta.dir,
  '../../drizzle/20260908060829_faulty_giant_girl.sql',
);

test('Payout status migration rewrites existing immutable history safely', async () => {
  const migration = await Bun.file(migrationPath).text();
  const statements = migration
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);
  const schemaName = `payout_status_migration_${crypto.randomUUID().replaceAll('-', '')}`;

  await sql.begin(async (transaction) => {
    await transaction.unsafe(`CREATE SCHEMA "${schemaName}"`);
    await transaction.unsafe(`SET LOCAL search_path TO "${schemaName}"`);

    await transaction.unsafe(`
      CREATE TABLE "payment_payouts" (
        id integer PRIMARY KEY,
        user_id integer NOT NULL,
        payout_status text NOT NULL,
        CONSTRAINT "payment_payouts_status_check"
          CHECK (payout_status IN ('CREATING', 'PENDING', 'AWAITING_RECONCILIATION', 'COMPLETED', 'FAILED', 'CANCELLED'))
      )
    `);
    await transaction.unsafe(`
      CREATE UNIQUE INDEX "payment_payouts_active_user_uidx"
      ON "payment_payouts" (user_id)
      WHERE payout_status IN ('CREATING', 'PENDING', 'AWAITING_RECONCILIATION')
    `);
    await transaction.unsafe(`
      CREATE TABLE "payment_payout_status_history" (
        id integer PRIMARY KEY,
        payout_id integer NOT NULL,
        from_status text,
        to_status text NOT NULL,
        source text NOT NULL,
        CONSTRAINT "payment_payout_status_history_from_status_check"
          CHECK (from_status IS NULL OR from_status IN ('CREATING', 'PENDING', 'AWAITING_RECONCILIATION', 'COMPLETED', 'FAILED', 'CANCELLED')),
        CONSTRAINT "payment_payout_status_history_to_status_check"
          CHECK (to_status IN ('CREATING', 'PENDING', 'AWAITING_RECONCILIATION', 'COMPLETED', 'FAILED', 'CANCELLED'))
      )
    `);
    await transaction.unsafe(`
      CREATE OR REPLACE FUNCTION payment_payout_status_history_immutable()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'Payout status history is immutable';
      END;
      $$
    `);
    await transaction.unsafe(`
      CREATE TRIGGER payment_payout_status_history_immutable
      BEFORE UPDATE OR DELETE ON payment_payout_status_history
      FOR EACH ROW EXECUTE FUNCTION payment_payout_status_history_immutable()
    `);
    await transaction.unsafe(`
      CREATE TABLE "payment_provider_event_inbox" (
        id integer PRIMARY KEY,
        resource_type text NOT NULL,
        normalized_status text NOT NULL,
        CONSTRAINT "payment_provider_event_inbox_normalized_status_check"
          CHECK (normalized_status IN ('PENDING', 'PAID', 'EXPIRED', 'FAILED', 'COMPLETED'))
      )
    `);

    await transaction.unsafe(`
      INSERT INTO "payment_payouts" (id, user_id, payout_status)
      VALUES (1, 1, 'CREATING')
    `);
    await transaction.unsafe(`
      INSERT INTO "payment_payout_status_history" (id, payout_id, from_status, to_status, source)
      VALUES (1, 1, 'CREATING', 'PENDING', 'ADMIN_REJECTION')
    `);
    await transaction.unsafe(`
      INSERT INTO "payment_provider_event_inbox" (id, resource_type, normalized_status)
      VALUES (1, 'PAYOUT', 'PENDING')
    `);

    for (const statement of statements) {
      // Migration statements must execute sequentially in their source order.
      // eslint-disable-next-line no-await-in-loop
      await transaction.unsafe(statement);
    }

    const [payout] = await transaction.unsafe<{
      payoutStatus: string;
      version: number;
    }[]>(
      'SELECT payout_status AS "payoutStatus", version FROM "payment_payouts" WHERE id = 1',
    );
    const [history] = await transaction.unsafe<{
      fromStatus: string;
      toStatus: string;
      source: string;
    }[]>(
      'SELECT from_status AS "fromStatus", to_status AS "toStatus", source FROM "payment_payout_status_history" WHERE id = 1',
    );
    const [providerEvent] = await transaction.unsafe<{
      normalizedStatus: string;
    }[]>(
      'SELECT normalized_status AS "normalizedStatus" FROM "payment_provider_event_inbox" WHERE id = 1',
    );
    const [trigger] = await transaction.unsafe<{
      enabled: string;
    }[]>(
      `SELECT tgenabled AS enabled
       FROM pg_trigger
       WHERE tgname = 'payment_payout_status_history_immutable'
         AND tgrelid = 'payment_payout_status_history'::regclass`,
    );

    expect(payout).toEqual({ payoutStatus: 'SUBMITTED_TO_PROVIDER', version: 1 });
    expect(history).toEqual({
      fromStatus: 'SUBMITTED_TO_PROVIDER',
      toStatus: 'PROVIDER_PENDING',
      source: 'ADMIN_CANCELLATION',
    });
    expect(providerEvent).toEqual({ normalizedStatus: 'PROVIDER_PENDING' });
    expect(trigger).toEqual({ enabled: 'O' });

    await transaction.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
  });
});
