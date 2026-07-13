import { describe, expect, it } from 'bun:test';
import postgres from 'postgres';

import { sha256, stableJson } from '@/modules/money/money.crypto';
import { MoneyError } from '@/modules/money/money.errors';
import { PostgresMoneyRepository } from '@/modules/money/postgres-money.repository';

const databaseUrl = Bun.env.TEST_DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;

const captureRejection = async (operation: PromiseLike<unknown>): Promise<unknown> => {
  try {
    await operation;
  } catch (error) {
    return error;
  }

  throw new Error('Expected operation to reject');
};

databaseDescribe('PostgreSQL money invariants', () => {
  it('provisions a wallet and converts earnings exactly once', async () => {
    const database = postgres(databaseUrl!, { prepare: false });
    const repository = new PostgresMoneyRepository(database);
    const userId = `money-test-${crypto.randomUUID()}`;
    const email = `${userId}@ku.th`;

    try {
      await database`
        INSERT INTO "user" (
          user_id, name, email, email_verified, first_name, last_name, updated_at
        ) VALUES (${userId}, 'Money Test', ${email}, true, 'Money', 'Test', now())
      `;

      const [wallet] = await database`
        SELECT id::text FROM wallets WHERE user_id = ${userId}
      `;
      expect(wallet?.id).toEqual(expect.any(String));
      if (!wallet) throw new Error('Expected a provisioned wallet');

      const [adjustment] = await database`
        SELECT id::text FROM ledger_accounts
        WHERE code = 'SYSTEM:ADJUSTMENTS'
      `;
      const [earnings] = await database`
        SELECT id::text FROM ledger_accounts
        WHERE wallet_id = ${wallet.id} AND type = 'EARNINGS'
      `;
      if (!adjustment || !earnings) {
        throw new Error('Expected earnings and adjustment ledger accounts');
      }
      const seedTransactionId = crypto.randomUUID();
      await database.begin(async (transaction) => {
        await transaction`
          INSERT INTO ledger_transactions (
            id, business_reference, event_type, created_by_user_id
          ) VALUES (
            ${seedTransactionId}, ${`test-seed:${seedTransactionId}`},
            'TEST_EARNINGS_SEED', ${userId}
          )
        `;
        await transaction`
          INSERT INTO ledger_postings (transaction_id, account_id, amount_baht)
          VALUES
            (${seedTransactionId}, ${earnings.id}, 500),
            (${seedTransactionId}, ${adjustment.id}, -500)
        `;
        await transaction`
          UPDATE ledger_transactions SET sealed_at = now()
          WHERE id = ${seedTransactionId}
        `;
      });

      const command = {
        userId,
        amount: 300,
        idempotencyKey: 'postgres-conversion-0001',
        requestHash: await sha256(stableJson({ amount: 300 })),
      };
      const conversion = await repository.convertEarnings(command);
      const replay = await repository.convertEarnings(command);
      expect(replay).toEqual(conversion);
      expect(conversion.earnings_balance_after).toBe(200);
      expect(conversion.spending_balance_after).toBe(300);

      const summary = await repository.getWallet(userId);
      expect(summary).toMatchObject({
        earnings_balance: 200,
        spending_balance: 300,
        held_for_jobs: 0,
        reserved_for_payouts: 0,
      });

      const conflict = await captureRejection(
        repository.convertEarnings({
          ...command,
          amount: 301,
          requestHash: await sha256(stableJson({ amount: 301 })),
        }),
      );
      expect(conflict).toBeInstanceOf(MoneyError);

      const [balance] = await database`
        SELECT SUM(posting.amount_baht)::integer AS total
        FROM earnings_conversions conversion
        JOIN ledger_postings posting
          ON posting.transaction_id = conversion.ledger_transaction_id
        WHERE conversion.id = ${conversion.id}
      `;
      expect(balance?.total).toBe(0);

      const concurrent = await Promise.allSettled([
        repository.convertEarnings({
          userId,
          amount: 150,
          idempotencyKey: 'postgres-concurrent-0001',
          requestHash: await sha256(stableJson({ amount: 150 })),
        }),
        repository.convertEarnings({
          userId,
          amount: 150,
          idempotencyKey: 'postgres-concurrent-0002',
          requestHash: await sha256(stableJson({ amount: 150 })),
        }),
      ]);
      expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(concurrent.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(await repository.getWallet(userId)).toMatchObject({
        earnings_balance: 50,
        spending_balance: 450,
      });
    } finally {
      await database.end({ timeout: 1 });
    }
  }, 15_000);
});
