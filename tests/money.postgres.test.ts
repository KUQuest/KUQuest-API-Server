/* oxlint-disable typescript/no-unsafe-type-assertion -- Integration tests inspect typed SQL fixtures. */
import { SQL } from 'bun';
import { describe, expect, it } from 'bun:test';

import { sha256, stableJson } from '@/modules/money/money.crypto';
import { PostgresMoneyRepository } from '@/modules/money/postgres-money.repository';

const databaseUrl = Bun.env.TEST_DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;

databaseDescribe('PostgreSQL money invariants', () => {
  it('commits a balanced conversion, replays idempotently, and rebuilds balances', async () => {
    const database = new SQL(databaseUrl!);
    const repository = new PostgresMoneyRepository(database);
    const userId = `test-user-${crypto.randomUUID()}`;
    const walletId = `wal_${crypto.randomUUID()}`;
    const earningsAccountId = `lac_${crypto.randomUUID()}`;
    const seedTransactionId = `ltx_${crypto.randomUUID()}`;

    await database.begin(async (transaction) => {
      await transaction`
        INSERT INTO wallets (id, user_id, earnings_balance)
        VALUES (${walletId}, ${userId}, 500)
      `;
      await transaction`
        INSERT INTO ledger_accounts (id, user_id, compartment)
        VALUES (${earningsAccountId}, ${userId}, 'EARNINGS')
      `;
      await transaction`
        INSERT INTO ledger_transactions (
          id, type, actor_user_id, resource_type, resource_id
        ) VALUES (
          ${seedTransactionId}, 'TEST_EARNINGS_SEED', ${userId},
          'ADJUSTMENT', ${`seed_${crypto.randomUUID()}`}
        )
      `;
      await transaction`
        INSERT INTO ledger_postings (id, transaction_id, account_id, amount)
        VALUES
          (${`lpo_${crypto.randomUUID()}`}, ${seedTransactionId}, ${earningsAccountId}, 500),
          (${`lpo_${crypto.randomUUID()}`}, ${seedTransactionId}, 'lac_system_clearing', -500)
      `;
    });

    const command = {
      userId,
      amount: 300,
      idempotencyKey: 'postgres-conversion-request-0001',
      requestHash: await sha256(stableJson({ amount: 300 })),
    };
    const conversion = await repository.convertEarnings(command);
    const replay = await repository.convertEarnings(command);
    expect(replay).toEqual(conversion);
    expect(conversion.earnings_balance_after).toBe(200);
    expect(conversion.spending_balance_after).toBe(300);

    const [idempotencyJson] = await database`
      SELECT jsonb_typeof(response_body) AS type
      FROM idempotency_records
      WHERE actor_id = ${userId}
        AND operation = 'EARNINGS_CONVERSION'
        AND idempotency_key = ${command.idempotencyKey}
    `;
    expect(idempotencyJson?.type).toBe('object');

    const transactionTotals = (await database`
      SELECT transaction_id, SUM(amount)::integer AS total
      FROM ledger_postings
      WHERE transaction_id IN (
        SELECT id FROM ledger_transactions WHERE actor_user_id = ${userId}
      )
      GROUP BY transaction_id
    `) as Array<{ transaction_id: string; total: number }>;
    expect(transactionTotals.length).toBe(2);
    expect(transactionTotals.every((row) => row.total === 0)).toBe(true);

    const rebuilt = (await database`
      SELECT account.compartment, SUM(posting.amount)::integer AS balance
      FROM ledger_postings posting
      JOIN ledger_accounts account ON account.id = posting.account_id
      WHERE account.user_id = ${userId}
      GROUP BY account.compartment
    `) as Array<{ compartment: string; balance: number }>;
    expect(rebuilt).toEqual(
      expect.arrayContaining([
        { compartment: 'EARNINGS', balance: 200 },
        { compartment: 'SPENDING', balance: 300 },
      ]),
    );

    const [wallet] = await database`
      SELECT spending_balance, earnings_balance
      FROM wallets WHERE user_id = ${userId}
    `;
    expect(wallet).toMatchObject({ spending_balance: 300, earnings_balance: 200 });

    const mutation = database`
      UPDATE ledger_postings SET amount = 1
      WHERE transaction_id = ${seedTransactionId}
    `.execute();
    try {
      await mutation;
      throw new Error('Expected immutable ledger mutation to fail.');
    } catch (error) {
      expect(String(error)).toContain('ledger history is immutable');
    }

    const webhookObjectId = `py_${crypto.randomUUID()}`;
    const webhook = {
      provider: 'XENDIT' as const,
      eventKey: await sha256(
        `payment.capture:${webhookObjectId}:SUCCEEDED`,
      ),
      payloadHash: await sha256('payload-one'),
      eventType: 'payment.capture',
      objectId: webhookObjectId,
      payload: {
        event: 'payment.capture',
        data: { payment_id: webhookObjectId },
      },
      receivedAt: new Date().toISOString(),
    };
    expect((await repository.storeWebhook(webhook)).duplicate).toBe(false);
    expect((await repository.storeWebhook(webhook)).duplicate).toBe(true);
    const [storedWebhook] = await database`
      SELECT jsonb_typeof(payload) AS type
      FROM provider_webhook_inbox
      WHERE provider = 'XENDIT' AND event_key = ${webhook.eventKey}
    `;
    expect(storedWebhook?.type).toBe('object');

    const latePosting = database`
      INSERT INTO ledger_postings (id, transaction_id, account_id, amount)
      VALUES (${`lpo_${crypto.randomUUID()}`}, ${seedTransactionId}, ${earningsAccountId}, 1)
    `.execute();
    try {
      await latePosting;
      throw new Error('Expected late posting append to fail.');
    } catch (error) {
      expect(String(error)).toContain(
        'cannot append postings to a committed ledger transaction',
      );
    }

    const accountMutation = database`
      UPDATE ledger_accounts SET compartment = 'SPENDING'
      WHERE id = ${earningsAccountId}
    `.execute();
    try {
      await accountMutation;
      throw new Error('Expected ledger account mutation to fail.');
    } catch (error) {
      expect(String(error)).toContain('ledger history is immutable');
    }

    void database.close();
  }, 15_000);

  it('serializes concurrent conversions so earnings cannot be overspent', async () => {
    const database = new SQL(databaseUrl!);
    const repository = new PostgresMoneyRepository(database);
    const userId = `test-user-${crypto.randomUUID()}`;
    const earningsAccountId = `lac_${crypto.randomUUID()}`;
    const seedTransactionId = `ltx_${crypto.randomUUID()}`;

    await database.begin(async (transaction) => {
      await transaction`
        INSERT INTO wallets (id, user_id, earnings_balance)
        VALUES (${`wal_${crypto.randomUUID()}`}, ${userId}, 200)
      `;
      await transaction`
        INSERT INTO ledger_accounts (id, user_id, compartment)
        VALUES (${earningsAccountId}, ${userId}, 'EARNINGS')
      `;
      await transaction`
        INSERT INTO ledger_transactions (
          id, type, actor_user_id, resource_type, resource_id
        ) VALUES (
          ${seedTransactionId}, 'TEST_EARNINGS_SEED', ${userId},
          'ADJUSTMENT', ${`seed_${crypto.randomUUID()}`}
        )
      `;
      await transaction`
        INSERT INTO ledger_postings (id, transaction_id, account_id, amount)
        VALUES
          (${`lpo_${crypto.randomUUID()}`}, ${seedTransactionId}, ${earningsAccountId}, 200),
          (${`lpo_${crypto.randomUUID()}`}, ${seedTransactionId}, 'lac_system_clearing', -200)
      `;
    });

    const outcomes = await Promise.allSettled([
      repository.convertEarnings({
        userId,
        amount: 150,
        idempotencyKey: 'postgres-concurrent-request-01',
        requestHash: await sha256(stableJson({ amount: 150 })),
      }),
      repository.convertEarnings({
        userId,
        amount: 150,
        idempotencyKey: 'postgres-concurrent-request-02',
        requestHash: await sha256(stableJson({ amount: 150 })),
      }),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const wallet = await repository.getWallet(userId);
    expect(wallet.earnings_balance).toBe(50);
    expect(wallet.spending_balance).toBe(150);
    void database.close();
  }, 15_000);
});
