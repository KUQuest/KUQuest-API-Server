import { describe, expect, it } from 'bun:test';
import postgres, { type Sql } from 'postgres';

import { sha256, stableJson } from '@/modules/money/money.crypto';
import { PostgresMoneyRepository } from '@/modules/money/postgres-money.repository';
import { MoneyError } from '@/modules/money/money.errors';
import { PostgresPaymentsRepository } from '@/modules/payments/postgres-payments.repository';
import type { XenditClient } from '@/modules/payments/payments.types';

const databaseUrl = Bun.env.TEST_DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;
const rejection = async (operation: Promise<unknown>) => {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error('Expected rejection.');
};

const seedEarnings = async (
  database: Sql,
  userId: string,
  amount: number,
  referencePrefix: string,
): Promise<void> => {
  const [wallet] =
    await database`SELECT id::text FROM wallets WHERE user_id=${userId}`;
  const [earnings] =
    await database`SELECT id::text FROM ledger_accounts WHERE wallet_id=${wallet?.id} AND type='EARNINGS'`;
  const [adjustments] =
    await database`SELECT id::text FROM ledger_accounts WHERE code='SYSTEM:ADJUSTMENTS'`;
  if (!wallet || !earnings || !adjustments) {
    throw new Error('Expected provisioned payout ledger accounts.');
  }

  const transactionId = crypto.randomUUID();
  await database.begin(async (transaction) => {
    await transaction`INSERT INTO ledger_transactions(id,business_reference,event_type)
      VALUES(${transactionId},${`${referencePrefix}:${transactionId}`},'TEST_SEED')`;
    await transaction`INSERT INTO ledger_postings(transaction_id,account_id,amount_baht) VALUES
      (${transactionId},${earnings.id},${amount}),
      (${transactionId},${adjustments.id},${-amount})`;
    await transaction`UPDATE ledger_transactions SET sealed_at=now()
      WHERE id=${transactionId}`;
  });
};

class FakeXendit implements XenditClient {
  async createPromptPay(input: {
    reference: string;
    amountBaht: number;
    expiresAt: string;
  }) {
    return {
      paymentRequestId: `pr-${input.reference}`,
      status: 'REQUIRES_ACTION',
      qrString: 'provider-test-qr',
      expiresAt: input.expiresAt,
    };
  }
  async simulatePayment() {
    return { status: 'PENDING' };
  }
  async createPayout(input: { reference: string }) {
    return { payoutId: `po-${input.reference}`, status: 'ACCEPTED' };
  }
}
class RejectingXendit extends FakeXendit {
  override async createPayout(): Promise<never> {
    throw new MoneyError(
      422,
      'VALIDATION_FAILED',
      'Provider rejected test payout.',
    );
  }
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

class BlockingXendit extends FakeXendit {
  readonly topUpStarted = deferred();
  readonly payoutStarted = deferred();
  readonly releaseTopUp = deferred();
  readonly releasePayout = deferred();
  topUpRequests = 0;
  payoutRequests = 0;

  override async createPromptPay(input: {
    reference: string;
    amountBaht: number;
    expiresAt: string;
  }) {
    this.topUpRequests += 1;
    this.topUpStarted.resolve();
    await this.releaseTopUp.promise;
    return super.createPromptPay(input);
  }

  override async createPayout(input: { reference: string }) {
    this.payoutRequests += 1;
    this.payoutStarted.resolve();
    await this.releasePayout.promise;
    return super.createPayout(input);
  }
}

databaseDescribe('PostgreSQL top-up and payout flow', () => {
  it('credits PromptPay once and reserves/finalizes worker earnings', async () => {
    const database = postgres(databaseUrl!, { prepare: false });
    const userId = `payments-${crypto.randomUUID()}`;
    const money = new PostgresMoneyRepository(database);
    const payments = new PostgresPaymentsRepository(database, new FakeXendit());
    try {
      await database`INSERT INTO "user"(user_id,name,email,email_verified,first_name,last_name,updated_at)
        VALUES(${userId},'Payment Worker',${`${userId}@ku.th`},true,'Payment','Worker',now())`;

      const quote = await payments.createTopUpQuote(userId, 100);
      expect(quote).toMatchObject({
        credit_baht: 100,
        fee_baht: 0,
        tax_baht: 0,
        payment_total_baht: 100,
      });
      const created = await payments.createTopUp(
        userId,
        quote.id,
        'topup-test-0001',
      );
      expect(created.status).toBe('REQUIRES_ACTION');
      expect(
        await payments.createTopUp(userId, quote.id, 'topup-test-0001'),
      ).toEqual(created);
      const payload = {
        event: 'payment.capture',
        data: {
          payment_request_id: created.provider_reference,
          reference_id: created.reference,
          request_amount: 100,
          currency: 'THB',
          status: 'SUCCEEDED',
        },
      };
      const payloadHash = await sha256(stableJson(payload));
      await money.storeWebhook({
        provider: 'XENDIT',
        family: 'payment',
        eventKey: crypto.randomUUID(),
        payloadHash,
        eventType: 'payment.capture',
        objectId: created.provider_reference,
        payload,
        receivedAt: new Date().toISOString(),
      });
      await payments.processStoredWebhooks();
      await payments.processStoredWebhooks();
      expect(await money.getWallet(userId)).toMatchObject({
        spending_balance: 100,
        earnings_balance: 0,
      });
      expect((await payments.getTopUp(userId, created.id)).status).toBe(
        'SUCCEEDED',
      );

      const failedQuote = await payments.createTopUpQuote(userId, 50);
      const failedTopUp = await payments.createTopUp(
        userId,
        failedQuote.id,
        'topup-test-failed-0001',
      );
      const failedPayload = {
        event: 'payment.failed',
        data: {
          payment_request_id: failedTopUp.provider_reference,
          reference_id: failedTopUp.reference,
          request_amount: 50,
          currency: 'THB',
          status: 'FAILED',
        },
      };
      await money.storeWebhook({
        provider: 'XENDIT',
        family: 'payment',
        eventKey: crypto.randomUUID(),
        payloadHash: await sha256(stableJson(failedPayload)),
        eventType: 'payment.failed',
        objectId: failedTopUp.provider_reference,
        payload: failedPayload,
        receivedAt: new Date().toISOString(),
      });
      await payments.processStoredWebhooks();
      expect((await payments.getTopUp(userId, failedTopUp.id)).status).toBe(
        'FAILED',
      );
      expect((await money.getWallet(userId)).spending_balance).toBe(100);

      await seedEarnings(database, userId, 500, 'test');
      const destination = await payments.savePayoutAccount(userId, {
        given_name: 'Test',
        surname: 'Worker',
        account_holder_name: 'Test Worker',
        account_number: '123456',
        bank_code: 'BBL',
      });
      const payoutQuote = await payments.createPayoutQuote(userId, 200);
      expect(payoutQuote.payout_account_id).toBe(destination.id);
      const payout = await payments.createPayout(
        userId,
        payoutQuote.id,
        'payout-test-0001',
      );
      expect(
        await payments.createPayout(userId, payoutQuote.id, 'payout-test-0001'),
      ).toEqual(payout);
      expect(await money.getWallet(userId)).toMatchObject({
        earnings_balance: 300,
        reserved_for_payouts: 200,
      });
      const payoutPayload = {
        event: 'payout.succeeded',
        data: {
          payout_id: payout.provider_reference,
          reference_id: `kuquest-payout-${payout.id}`,
          amount: 200,
          currency: 'THB',
          status: 'SUCCEEDED',
        },
      };
      await money.storeWebhook({
        provider: 'XENDIT',
        family: 'payout',
        eventKey: crypto.randomUUID(),
        payloadHash: await sha256(stableJson(payoutPayload)),
        eventType: 'payout.succeeded',
        objectId: payout.provider_reference,
        payload: payoutPayload,
        receivedAt: new Date().toISOString(),
      });
      await payments.processStoredWebhooks();
      expect(await money.getWallet(userId)).toMatchObject({
        earnings_balance: 300,
        reserved_for_payouts: 0,
      });
      expect((await payments.getPayout(userId, payout.id)).status).toBe(
        'SUCCEEDED',
      );
    } finally {
      await database.end({ timeout: 1 });
    }
  }, 20_000);

  it('releases a payout reserve after a deterministic provider rejection', async () => {
    const database = postgres(databaseUrl!, { prepare: false });
    const userId = `payout-reject-${crypto.randomUUID()}`;
    const money = new PostgresMoneyRepository(database);
    const payments = new PostgresPaymentsRepository(
      database,
      new RejectingXendit(),
    );
    try {
      await database`INSERT INTO "user"(user_id,name,email,email_verified,first_name,last_name,updated_at)
        VALUES(${userId},'Rejected Worker',${`${userId}@ku.th`},true,'Rejected','Worker',now())`;
      await seedEarnings(database, userId, 200, 'test-reject');
      await payments.savePayoutAccount(userId, {
        given_name: 'Rejected',
        surname: 'Worker',
        account_holder_name: 'Rejected Worker',
        account_number: '121212',
        bank_code: 'BBL',
      });
      const quote = await payments.createPayoutQuote(userId, 100);
      expect(
        await rejection(
          payments.createPayout(userId, quote.id, 'payout-rejected-0001'),
        ),
      ).toBeInstanceOf(MoneyError);
      expect(await money.getWallet(userId)).toMatchObject({
        earnings_balance: 200,
        reserved_for_payouts: 0,
      });
      expect((await payments.listPayouts(userId))[0]).toMatchObject({
        status: 'FAILED',
      });
      expect(
        await rejection(
          payments.createPayout(userId, quote.id, 'payout-rejected-0001'),
        ),
      ).toMatchObject({ status: 422 });
    } finally {
      await database.end({ timeout: 1 });
    }
  }, 20_000);

  it('atomically claims top-up and payout idempotency keys', async () => {
    const database = postgres(databaseUrl!, { prepare: false });
    const userId = `payment-idempotency-${crypto.randomUUID()}`;
    const xendit = new BlockingXendit();
    const payments = new PostgresPaymentsRepository(database, xendit);

    try {
      await database`
        INSERT INTO "user" (
          user_id, name, email, email_verified, first_name, last_name, updated_at
        ) VALUES (
          ${userId}, 'Idempotency Worker', ${`${userId}@ku.th`}, true,
          'Idempotency', 'Worker', now()
        )
      `;

      const topUpQuote = await payments.createTopUpQuote(userId, 100);
      const firstTopUp = payments.createTopUp(
        userId,
        topUpQuote.id,
        'concurrent-topup-key-0001',
      );
      await xendit.topUpStarted.promise;
      expect(
        await rejection(
          payments.createTopUp(
            userId,
            topUpQuote.id,
            'concurrent-topup-key-0001',
          ),
        ),
      ).toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
      xendit.releaseTopUp.resolve();
      await firstTopUp;
      expect(xendit.topUpRequests).toBe(1);

      await seedEarnings(database, userId, 500, 'idempotency-test');
      await payments.savePayoutAccount(userId, {
        given_name: 'Idempotency',
        surname: 'Worker',
        account_holder_name: 'Idempotency Worker',
        account_number: '1234567890',
        bank_code: 'BBL',
      });
      const payoutQuote = await payments.createPayoutQuote(userId, 100);
      const firstPayout = payments.createPayout(
        userId,
        payoutQuote.id,
        'concurrent-payout-key-0001',
      );
      await xendit.payoutStarted.promise;
      expect(
        await rejection(
          payments.createPayout(
            userId,
            payoutQuote.id,
            'concurrent-payout-key-0001',
          ),
        ),
      ).toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
      xendit.releasePayout.resolve();
      await firstPayout;
      expect(xendit.payoutRequests).toBe(1);
    } finally {
      xendit.releaseTopUp.resolve();
      xendit.releasePayout.resolve();
      await database.end({ timeout: 1 });
    }
  }, 20_000);
});
