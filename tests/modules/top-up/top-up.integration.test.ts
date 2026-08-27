import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import {
  paymentTopUp,
  paymentTopUpQuote,
  paymentTopUpStatusHistory,
} from '@/database/schema/payment.schema';
import {
  ensureInitialMoneyPolicy,
  createSealedLedgerTransaction,
  getWallet,
  ensureWallet,
  positiveSatang,
  signedSatang,
} from '@/modules/wallet';
import { MAX_WALLET_CAPACITY_SATANG } from '@/modules/wallet/wallet.money';
import {
  walletIdempotencyKey,
  walletLedgerAccount,
  walletWallet,
} from '@/database/schema/wallet.schema';
import {
  InboundPaymentProviderError,
  getTopUp,
  initiateTopUp,
  listTopUpStatusHistory,
  listTopUps,
  quoteTopUp,
} from '@/modules/top-up';
import type {
  InboundPaymentProvider,
  InboundPaymentRequest,
  InboundPaymentResponse,
} from '@/modules/top-up';

import { beforeAll, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';

class FakeInboundPaymentProvider implements InboundPaymentProvider {
  readonly requests: InboundPaymentRequest[] = [];
  readonly referencePrefix = `pr-test-${crypto.randomUUID()}`;
  private attempt = 0;
  mode: 'success' | 'rejected' | 'uncertain' = 'success';

  async createPayment(input: InboundPaymentRequest): Promise<InboundPaymentResponse> {
    this.requests.push(input);
    this.attempt += 1;
    if (this.mode === 'rejected') {
      throw new InboundPaymentProviderError('PROVIDER_REJECTED', 'Provider rejected the request.', {
        providerCode: 'TEST_REJECTED',
        providerApiVersion: 'test-v1',
      });
    }
    if (this.mode === 'uncertain' && this.attempt === 1) {
      throw new InboundPaymentProviderError('PROVIDER_UNCERTAIN', 'Provider response is uncertain.');
    }
    return {
      providerReference: `${this.referencePrefix}-${this.attempt}`,
      providerStatus: 'REQUIRES_ACTION',
      providerAmountSatang: input.paymentTotalSatang,
      providerApiVersion: 'test-v1',
      providerChannelCode: 'TEST_QR',
      qrPayload: `qr-${this.attempt}`,
      qrExpiresAt: input.expiresAt,
    };
  }
}

const createMember = async (prefix: string) => {
  const userId = crypto.randomUUID();
  await db.insert(authUser).values({
    id: userId,
    email: `${userId}@ku.th`,
    firstName: 'Top-up',
    lastName: 'Test',
  });
  await ensureWallet(userId);
  return userId;
};

beforeAll(async () => {
  await sql`select 1`;
  await ensureInitialMoneyPolicy();
});

describe('Top-up application services', () => {
  it('quotes in satang and initiates multiple independent pending Top-ups', async () => {
    const userId = await createMember('be113-success');
    const provider = new FakeInboundPaymentProvider();
    const quote = await quoteTopUp({ principalUserId: userId, creditSatang: positiveSatang(123) });

    expect(quote).toMatchObject({
      principalUserId: userId,
      creditSatang: 123,
      chargedFeeSatang: 0,
      chargedTaxSatang: 0,
      paymentTotalSatang: 123,
      providerTotalSatang: 123,
    });
    expect(quote.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const first = await initiateTopUp({
      principalUserId: userId,
      quoteId: quote.id,
      idempotency: { key: 'be113-success-1' },
    }, provider);
    const secondQuote = await quoteTopUp({ principalUserId: userId, creditSatang: positiveSatang(456) });
    const second = await initiateTopUp({
      principalUserId: userId,
      quoteId: secondQuote.id,
      idempotency: { key: 'be113-success-2' },
    }, provider);

    expect(first).toMatchObject({
      principalUserId: userId,
      topUpStatus: 'PENDING',
      creditSatang: 123,
      paymentTotalSatang: 123,
      providerReference: `${provider.referencePrefix}-1`,
      qrPayload: 'qr-1',
    });
    expect(second.id).not.toBe(first.id);
    expect(provider.requests.map(({ paymentTotalSatang }) => paymentTotalSatang))
      .toEqual([positiveSatang(123), positiveSatang(456)]);

    const replay = await initiateTopUp({
      principalUserId: userId,
      quoteId: quote.id,
      idempotency: { key: 'be113-success-1' },
    }, provider);
    expect(replay).toEqual(first);
    expect(await listTopUps(userId)).toHaveLength(2);
    expect(await getTopUp(userId, first.id)).toEqual(first);
    expect(await listTopUpStatusHistory(userId, first.id)).toMatchObject([
      { fromStatus: null, toStatus: 'PENDING', source: 'INITIATION' },
    ]);
  });

  it('consumes a quote only once and scopes ownership to the Member', async () => {
    const ownerId = await createMember('be113-owner');
    const otherId = await createMember('be113-other');
    const quote = await quoteTopUp({ principalUserId: ownerId, creditSatang: positiveSatang(100) });
    const provider = new FakeInboundPaymentProvider();

    await expect(initiateTopUp({
      principalUserId: otherId,
      quoteId: quote.id,
      idempotency: { key: 'be113-wrong-owner' },
    }, provider)).rejects.toMatchObject({ code: 'TOP_UP_QUOTE_NOT_FOUND' });

    await initiateTopUp({
      principalUserId: ownerId,
      quoteId: quote.id,
      idempotency: { key: 'be113-owner-1' },
    }, provider);
    await expect(initiateTopUp({
      principalUserId: ownerId,
      quoteId: quote.id,
      idempotency: { key: 'be113-owner-2' },
    }, provider)).rejects.toMatchObject({ code: 'TOP_UP_QUOTE_CONSUMED' });
  });

  it('retains a rejected provider result without changing Wallet balances', async () => {
    const userId = await createMember('be113-rejected');
    const walletBefore = await getWallet(userId);
    const provider = new FakeInboundPaymentProvider();
    provider.mode = 'rejected';
    const quote = await quoteTopUp({ principalUserId: userId, creditSatang: positiveSatang(100) });

    await expect(initiateTopUp({
      principalUserId: userId,
      quoteId: quote.id,
      idempotency: { key: 'be113-rejected-1' },
    }, provider)).rejects.toMatchObject({ code: 'PROVIDER_REJECTED' });

    const [topUp] = await db.select().from(paymentTopUp).where(eq(paymentTopUp.quoteId, quote.id));
    expect(topUp).toMatchObject({
      topUpStatus: 'FAILED',
      providerStatus: 'TEST_REJECTED',
      providerApiVersion: 'test-v1',
    });
    expect(await db.select().from(paymentTopUpStatusHistory).where(eq(paymentTopUpStatusHistory.topUpId, topUp.id)))
      .toMatchObject([
        { toStatus: 'PENDING', source: 'INITIATION' },
        { fromStatus: 'PENDING', toStatus: 'FAILED', source: 'PROVIDER' },
      ]);
    expect(await getWallet(userId)).toMatchObject({
      spendingBalanceSatang: walletBefore.spendingBalanceSatang,
      earningsBalanceSatang: walletBefore.earningsBalanceSatang,
      fundingReservedSatang: walletBefore.fundingReservedSatang,
      reservedForPayoutsSatang: walletBefore.reservedForPayoutsSatang,
    });
    expect((await getTopUp(userId, topUp.id)).topUpStatus).toBe('FAILED');
  });

  it('counts pending Top-ups against Wallet capacity before the provider call', async () => {
    const userId = await createMember('be113-capacity');
    const provider = new FakeInboundPaymentProvider();
    const [wallet] = await db.select().from(walletWallet).where(eq(walletWallet.userId, userId));
    if (!wallet) throw new Error('Wallet was not provisioned.');
    const [spendingAccount] = await db.select({ id: walletLedgerAccount.id })
      .from(walletLedgerAccount)
      .where(and(
        eq(walletLedgerAccount.walletId, wallet.id),
        eq(walletLedgerAccount.type, 'SPENDING'),
      ));
    const [suspenseAccount] = await db.select({ id: walletLedgerAccount.id })
      .from(walletLedgerAccount)
      .where(eq(walletLedgerAccount.code, 'platform:PLATFORM_SUSPENSE'));
    if (!spendingAccount || !suspenseAccount) throw new Error('Wallet accounts were not provisioned.');
    await createSealedLedgerTransaction({
      businessReference: `be113-capacity-funding-${crypto.randomUUID()}`,
      eventType: 'TOP_UP',
      postings: [
        { accountId: spendingAccount.id, amountSatang: signedSatang(MAX_WALLET_CAPACITY_SATANG - 100) },
        { accountId: suspenseAccount.id, amountSatang: signedSatang(-(MAX_WALLET_CAPACITY_SATANG - 100)) },
      ],
    });

    const firstQuote = await quoteTopUp({ principalUserId: userId, creditSatang: positiveSatang(100) });
    await initiateTopUp({
      principalUserId: userId,
      quoteId: firstQuote.id,
      idempotency: { key: 'be113-capacity-1' },
    }, provider);

    const secondQuote = await quoteTopUp({ principalUserId: userId, creditSatang: positiveSatang(100) });
    await expect(initiateTopUp({
      principalUserId: userId,
      quoteId: secondQuote.id,
      idempotency: { key: 'be113-capacity-2' },
    }, provider)).rejects.toMatchObject({ code: 'WALLET_CAPACITY_EXCEEDED' });
    expect(provider.requests).toHaveLength(1);
  });

  it('rolls back the initiation transaction when the Top-up insert fails', async () => {
    const userId = await createMember('be113-atomicity');
    const provider = new FakeInboundPaymentProvider();
    const quote = await quoteTopUp({ principalUserId: userId, creditSatang: positiveSatang(100) });
    await db.insert(paymentTopUp).values({
      internalReference: `be113-conflict-${crypto.randomUUID()}`,
      userId,
      quoteId: quote.id,
      provider: 'TEST',
      creditSatang: quote.creditSatang,
      chargedFeeSatang: quote.chargedFeeSatang,
      chargedTaxSatang: quote.chargedTaxSatang,
      paymentTotalSatang: quote.paymentTotalSatang,
      providerFeeSatang: quote.providerFeeSatang,
      providerTaxSatang: quote.providerTaxSatang,
      providerTotalSatang: quote.providerTotalSatang,
      topUpStatus: 'PENDING',
    });

    await expect(initiateTopUp({
      principalUserId: userId,
      quoteId: quote.id,
      idempotency: { key: 'be113-atomicity-1' },
    }, provider)).rejects.toThrow();

    const [unchangedQuote] = await db.select().from(paymentTopUpQuote).where(eq(paymentTopUpQuote.id, quote.id));
    expect(unchangedQuote?.consumedAt).toBeNull();
    expect(await db.select().from(walletIdempotencyKey).where(eq(walletIdempotencyKey.key, 'be113-atomicity-1')))
      .toHaveLength(0);
    expect(provider.requests).toHaveLength(0);
  });

  it('retains a Top-up Quote when deletion is requested', async () => {
    const userId = await createMember('be113-retention');
    const quote = await quoteTopUp({ principalUserId: userId, creditSatang: positiveSatang(100) });

    await expect(db.delete(paymentTopUpQuote).where(eq(paymentTopUpQuote.id, quote.id)).execute())
      .rejects.toThrow();
    expect(await db.select().from(paymentTopUpQuote).where(eq(paymentTopUpQuote.id, quote.id)))
      .toHaveLength(1);
  });

  it('serializes concurrent initiation attempts for one quote', async () => {
    const userId = await createMember('be113-concurrent');
    const provider = new FakeInboundPaymentProvider();
    const quote = await quoteTopUp({ principalUserId: userId, creditSatang: positiveSatang(100) });
    const attempts = [
      initiateTopUp({
        principalUserId: userId,
        quoteId: quote.id,
        idempotency: { key: 'be113-concurrent-1' },
      }, provider),
      initiateTopUp({
        principalUserId: userId,
        quoteId: quote.id,
        idempotency: { key: 'be113-concurrent-2' },
      }, provider),
    ];

    const results = await Promise.allSettled(attempts);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected'))
      .toMatchObject([{ reason: { code: 'TOP_UP_QUOTE_CONSUMED' } }]);
    expect(provider.requests).toHaveLength(1);
  });

  it('keeps an uncertain result retryable with the same internal reference', async () => {
    const userId = await createMember('be113-uncertain');
    const provider = new FakeInboundPaymentProvider();
    provider.mode = 'uncertain';
    const quote = await quoteTopUp({ principalUserId: userId, creditSatang: positiveSatang(100) });
    const input = {
      principalUserId: userId,
      quoteId: quote.id,
      idempotency: { key: 'be113-uncertain-1' },
    };

    await expect(initiateTopUp(input, provider)).rejects.toMatchObject({ code: 'PROVIDER_UNCERTAIN' });
    const retried = await initiateTopUp(input, provider);

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0].internalReference).toBe(provider.requests[1].internalReference);
    expect(retried.topUpStatus).toBe('PENDING');
  });

  it('does not call the provider when the Wallet is not Active', async () => {
    const userId = await createMember('be113-status');
    const provider = new FakeInboundPaymentProvider();
    const quote = await quoteTopUp({ principalUserId: userId, creditSatang: positiveSatang(100) });
    const [wallet] = await db.select().from(walletWallet).where(eq(walletWallet.userId, userId));
    if (!wallet) throw new Error('Wallet was not provisioned.');
    await db.update(walletWallet)
      .set({ walletStatus: 'FROZEN' })
      .where(eq(walletWallet.id, wallet.id));

    await expect(initiateTopUp({
      principalUserId: userId,
      quoteId: quote.id,
      idempotency: { key: 'be113-status-1' },
    }, provider)).rejects.toMatchObject({ code: 'WALLET_NOT_ACTIVE' });
    expect(provider.requests).toHaveLength(0);
    expect(await db.select().from(paymentTopUp).where(eq(paymentTopUp.quoteId, quote.id))).toHaveLength(0);
  });
});
