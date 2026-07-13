import { describe, expect, it } from 'bun:test';
import postgres from 'postgres';

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

const userValues = (id: string, email: string) => ({
  id,
  email,
  name: 'Database Invariant Test',
  firstName: 'Database',
  lastName: 'Test',
});

databaseDescribe('PostgreSQL security and ledger invariants', () => {
  it('rejects non-KU users and atomically provisions one wallet with four accounts', async () => {
    const database = postgres(databaseUrl!, { prepare: false });
    const rejectedUser = userValues(
      `rejected-${crypto.randomUUID()}`,
      `rejected-${crypto.randomUUID()}@gmail.com`,
    );
    const acceptedUser = userValues(
      `accepted-${crypto.randomUUID()}`,
      `accepted-${crypto.randomUUID()}@ku.th`,
    );

    try {
      const rejection = await captureRejection(database`
        INSERT INTO "user" (
          user_id, name, email, email_verified, first_name, last_name, updated_at
        ) VALUES (
          ${rejectedUser.id}, ${rejectedUser.name}, ${rejectedUser.email}, true,
          ${rejectedUser.firstName}, ${rejectedUser.lastName}, now()
        )
      `);
      expect(rejection).toBeDefined();

      const [rejectedCount] = await database`
        SELECT count(*)::integer AS count FROM "user"
        WHERE user_id = ${rejectedUser.id}
      `;
      expect(rejectedCount?.count).toBe(0);

      await database`
        INSERT INTO "user" (
          user_id, name, email, email_verified, first_name, last_name, updated_at
        ) VALUES (
          ${acceptedUser.id}, ${acceptedUser.name}, ${acceptedUser.email}, true,
          ${acceptedUser.firstName}, ${acceptedUser.lastName}, now()
        )
      `;
      const [provisioned] = await database`
        SELECT count(DISTINCT wallet.id)::integer AS wallets,
               count(account.id)::integer AS accounts
        FROM wallets wallet
        JOIN ledger_accounts account ON account.wallet_id = wallet.id
        WHERE wallet.user_id = ${acceptedUser.id}
      `;
      expect(provisioned).toMatchObject({ wallets: 1, accounts: 4 });
    } finally {
      await database.end({ timeout: 1 });
    }
  });

  it('rejects incomplete ledgers, seals balanced ledgers, and prevents later mutation', async () => {
    const database = postgres(databaseUrl!, { prepare: false });
    const userId = `ledger-${crypto.randomUUID()}`;

    try {
      await database`
        INSERT INTO "user" (
          user_id, name, email, email_verified, first_name, last_name, updated_at
        ) VALUES (
          ${userId}, 'Ledger Test', ${`${userId}@ku.th`}, true,
          'Ledger', 'Test', now()
        )
      `;
      const [accounts] = await database`
        SELECT
          (SELECT id::text FROM ledger_accounts
            WHERE user_id = ${userId} AND type = 'EARNINGS') AS earnings_id,
          (SELECT id::text FROM ledger_accounts
            WHERE code = 'SYSTEM:ADJUSTMENTS') AS adjustment_id
      `;
      if (!accounts) throw new Error('Expected provisioned ledger accounts');

      const emptyTransactionId = crypto.randomUUID();
      const emptyRejection = await captureRejection(database.begin(async (transaction) => {
        await transaction`
          INSERT INTO ledger_transactions (
            id, business_reference, event_type, created_by_user_id
          ) VALUES (
            ${emptyTransactionId}, ${`empty:${emptyTransactionId}`},
            'TEST_EMPTY', ${userId}
          )
        `;
        await transaction`
          UPDATE ledger_transactions SET sealed_at = now()
          WHERE id = ${emptyTransactionId}
        `;
      }));
      expect(String(emptyRejection)).toContain(
        'at least two same-currency balanced postings',
      );

      const unbalancedTransactionId = crypto.randomUUID();
      const unbalancedRejection = await captureRejection(database.begin(async (transaction) => {
        await transaction`
          INSERT INTO ledger_transactions (
            id, business_reference, event_type, created_by_user_id
          ) VALUES (
            ${unbalancedTransactionId}, ${`unbalanced:${unbalancedTransactionId}`},
            'TEST_UNBALANCED', ${userId}
          )
        `;
        await transaction`
          INSERT INTO ledger_postings (transaction_id, account_id, amount_baht)
          VALUES (${unbalancedTransactionId}, ${accounts.earnings_id}, 10)
        `;
        await transaction`
          UPDATE ledger_transactions SET sealed_at = now()
          WHERE id = ${unbalancedTransactionId}
        `;
      }));
      expect(String(unbalancedRejection)).toContain(
        'at least two same-currency balanced postings',
      );

      const balancedTransactionId = crypto.randomUUID();
      await database.begin(async (transaction) => {
        await transaction`
          INSERT INTO ledger_transactions (
            id, business_reference, event_type, created_by_user_id
          ) VALUES (
            ${balancedTransactionId}, ${`balanced:${balancedTransactionId}`},
            'TEST_BALANCED', ${userId}
          )
        `;
        await transaction`
          INSERT INTO ledger_postings (transaction_id, account_id, amount_baht)
          VALUES
            (${balancedTransactionId}, ${accounts.earnings_id}, 10),
            (${balancedTransactionId}, ${accounts.adjustment_id}, -10)
        `;
        await transaction`
          UPDATE ledger_transactions SET sealed_at = now()
          WHERE id = ${balancedTransactionId}
        `;
      });

      const appendRejection = await captureRejection(database`
        INSERT INTO ledger_postings (transaction_id, account_id, amount_baht)
        VALUES (${balancedTransactionId}, ${accounts.earnings_id}, 1)
      `);
      expect(String(appendRejection)).toContain(
        'cannot append to a sealed ledger transaction',
      );
      const updateRejection = await captureRejection(database`
        UPDATE ledger_postings SET amount_baht = 1
        WHERE transaction_id = ${balancedTransactionId}
      `);
      expect(updateRejection).toBeDefined();
    } finally {
      await database.end({ timeout: 1 });
    }
  });

  it('prevents the runtime role from changing balances or database structure directly', async () => {
    const database = postgres(databaseUrl!, { prepare: false });
    const userId = `privilege-${crypto.randomUUID()}`;

    try {
      await database`
        INSERT INTO "user" (
          user_id, name, email, email_verified, first_name, last_name, updated_at
        ) VALUES (
          ${userId}, 'Privilege Test', ${`${userId}@ku.th`}, true,
          'Privilege', 'Test', now()
        )
      `;
      const balanceRejection = await captureRejection(database`
        UPDATE wallets SET spending_balance_baht = 999999
        WHERE user_id = ${userId}
      `);
      expect(balanceRejection).toBeDefined();
      const ddlRejection = await captureRejection(database.unsafe(
        `CREATE TABLE forbidden_${crypto.randomUUID().replaceAll('-', '')} (id integer)`,
      ));
      expect(ddlRejection).toBeDefined();
      const payoutReadRejection = await captureRejection(database`
        SELECT * FROM payout_accounts LIMIT 1
      `);
      expect(payoutReadRejection).toBeDefined();
    } finally {
      await database.end({ timeout: 1 });
    }
  });
});
