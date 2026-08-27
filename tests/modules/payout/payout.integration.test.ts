import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import {
  paymentPayoutAccounts,
  paymentPayouts,
  paymentPayoutQuotes,
} from '@/database/schema/payment.schema';
import {
  walletLedgerAccount,
  walletWallet,
} from '@/database/schema/wallet.schema';
import {
  createPayoutDestinationEncryption,
  PayoutDestinationEncryptionError,
  savePayoutDestination,
} from '@/modules/payout-destination';
import {
  changeWalletStatus,
  createSealedLedgerTransaction,
  ensureInitialMoneyPolicy,
  ensureWallet,
  getWallet,
  positiveSatang,
  satang,
  signedSatang,
} from '@/modules/wallet';
import {
  getPayout,
  initiatePayout,
  listPayoutStatusHistory,
  listPayouts,
  quotePayout,
} from '@/modules/payout';
import type {
  OutboundPayoutProvider,
  OutboundPayoutRequest,
  OutboundPayoutResponse,
} from '@/modules/payout';
import { PayoutProviderError } from '@/modules/payout';

import { beforeAll, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';

const encryption = createPayoutDestinationEncryption({
  activeKeyVersion: 'v1',
  keys: { v1: 'p'.repeat(32) },
});

class FakePayoutProvider implements OutboundPayoutProvider {
  readonly requests: OutboundPayoutRequest[] = [];
  readonly referencePrefix = `test-payout-${crypto.randomUUID()}`;
  private attempt = 0;
  mode: 'success' | 'rejected' | 'uncertain' | 'configuration' = 'success';

  async createPayout(input: OutboundPayoutRequest): Promise<OutboundPayoutResponse> {
    if (this.mode === 'configuration') {
      throw new PayoutProviderError('PROVIDER_CONFIGURATION', 'Provider configuration failed.', {
        providerApiVersion: 'test-v1',
      });
    }
    this.requests.push(input);
    this.attempt += 1;
    if (this.mode === 'rejected') {
      throw new PayoutProviderError('PROVIDER_REJECTED', 'Provider rejected the payout.', {
        providerCode: 'TEST_REJECTED',
        providerApiVersion: 'test-v1',
      });
    }
    if (this.mode === 'uncertain' && this.attempt === 1) {
      throw new PayoutProviderError('PROVIDER_UNCERTAIN', 'Provider response is uncertain.', {
        providerApiVersion: 'test-v1',
      });
    }
    return {
      providerReference: `${this.referencePrefix}-${this.attempt}`,
      providerStatus: 'ACCEPTED',
      providerAmountSatang: input.receiptSatang,
      actualFeeSatang: satang(0),
      actualTaxSatang: satang(0),
      actualDebitSatang: input.receiptSatang,
      providerApiVersion: 'test-v1',
    };
  }
}

const createStudent = async (prefix: string) => {
  const id = `${prefix}-${crypto.randomUUID()}`;
  await db.insert(authUser).values({
    id,
    email: `${id}@ku.th`,
    firstName: 'Payout',
    lastName: 'Student',
  });
  await ensureWallet(id);
  await savePayoutDestination({
    principalUserId: id,
    givenName: 'Payout',
    surname: 'Student',
    relationship: 'SELF',
    bankCode: 'SCB',
    accountNumber: '1234567890',
    accountHolderName: 'Payout Student',
    routingType: 'BANK_ACCOUNT',
    routingValue: '1234567890',
  }, encryption);
  return id;
};

const creditEarnings = async (studentId: string, amountSatang: number) => {
  const accounts = await db
    .select({ id: walletLedgerAccount.id, type: walletLedgerAccount.type })
    .from(walletLedgerAccount)
    .innerJoin(walletWallet, eq(walletLedgerAccount.walletId, walletWallet.id))
    .where(eq(walletWallet.userId, studentId));
  const suspense = await db
    .select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(eq(walletLedgerAccount.code, 'platform:PLATFORM_SUSPENSE'));
  const earnings = accounts.find((account) => account.type === 'EARNINGS');
  if (!earnings || !suspense[0]) throw new Error('Wallet accounts were not provisioned.');
  await createSealedLedgerTransaction({
    businessReference: `test-payout-credit:${crypto.randomUUID()}`,
    eventType: 'ADJUSTMENT',
    postings: [
      { accountId: earnings.id, amountSatang: signedSatang(amountSatang) },
      { accountId: suspense[0].id, amountSatang: signedSatang(-amountSatang) },
    ],
  });
};

beforeAll(async () => {
  await sql`select 1`;
  await ensureInitialMoneyPolicy();
});

describe('Payout application services', () => {
  it('quotes, reserves Earnings Balance, and initiates one Payout', async () => {
    const studentId = await createStudent('be115-success');
    await creditEarnings(studentId, 10_000);
    const provider = new FakePayoutProvider();
    const quote = await quotePayout({ principalUserId: studentId, receiptSatang: positiveSatang(1_234) });

    expect(quote).toMatchObject({
      principalUserId: studentId,
      receiptSatang: 1_234,
      maximumFeeSatang: 0,
      maximumTaxSatang: 0,
      maximumDebitSatang: 1_234,
      feeRoundingMode: 'UP',
    });

    const payout = await initiatePayout({
      principalUserId: studentId,
      quoteId: quote.id,
      idempotency: { key: 'be115-success-1' },
    }, provider, encryption);

    expect(payout).toMatchObject({
      principalUserId: studentId,
      quoteId: quote.id,
      payoutStatus: 'PENDING',
      receiptSatang: 1_234,
      maximumDebitSatang: 1_234,
      providerReference: `${provider.referencePrefix}-1`,
      providerAmountSatang: 1_234,
      actualDebitSatang: 1_234,
    });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.destination).toHaveProperty('accountNumber', '1234567890');
    expect(await getWallet(studentId)).toMatchObject({
      earningsBalanceSatang: 8_766,
      reservedForPayoutsSatang: 1_234,
    });
    expect(await initiatePayout({
      principalUserId: studentId,
      quoteId: quote.id,
      idempotency: { key: 'be115-success-1' },
    }, provider, encryption)).toEqual(payout);
    expect(await getPayout(studentId, payout.id)).toEqual(payout);
    expect(await listPayouts(studentId)).toHaveLength(1);
    expect(await listPayoutStatusHistory(studentId, payout.id)).toMatchObject([
      { fromStatus: null, toStatus: 'CREATING', source: 'INITIATION' },
      { fromStatus: 'CREATING', toStatus: 'PENDING', source: 'PROVIDER' },
    ]);
  });

  it('rejects ownership, inactive destinations, expired quotes, and insufficient Earnings Balance', async () => {
    const ownerId = await createStudent('be115-owner');
    const otherId = await createStudent('be115-other');
    const quote = await quotePayout({ principalUserId: ownerId, receiptSatang: positiveSatang(100) });
    const provider = new FakePayoutProvider();

    await expect(initiatePayout({
      principalUserId: otherId,
      quoteId: quote.id,
      idempotency: { key: 'be115-owner-wrong' },
    }, provider, encryption)).rejects.toMatchObject({ code: 'PAYOUT_QUOTE_NOT_FOUND' });
    await expect(initiatePayout({
      principalUserId: ownerId,
      quoteId: quote.id,
      idempotency: { key: 'be115-owner-insufficient' },
    }, provider, encryption)).rejects.toMatchObject({ code: 'INSUFFICIENT_EARNINGS_BALANCE' });
    expect(provider.requests).toHaveLength(0);

    const destination = await savePayoutDestination({
      principalUserId: ownerId,
      givenName: 'Payout',
      surname: 'Student',
      relationship: 'SELF',
      bankCode: 'SCB',
      accountNumber: '1234567891',
      accountHolderName: 'Payout Student',
      routingType: 'BANK_ACCOUNT',
      routingValue: '1234567891',
    }, encryption);
    expect(destination.retiredAt).toBeNull();
  });

  it('releases a confirmed provider failure and retains an uncertain reserve', async () => {
    const rejectedStudent = await createStudent('be115-rejected');
    await creditEarnings(rejectedStudent, 1_000);
    const rejectedQuote = await quotePayout({ principalUserId: rejectedStudent, receiptSatang: positiveSatang(100) });
    const rejectedProvider = new FakePayoutProvider();
    rejectedProvider.mode = 'rejected';

    await expect(initiatePayout({
      principalUserId: rejectedStudent,
      quoteId: rejectedQuote.id,
      idempotency: { key: 'be115-rejected-1' },
    }, rejectedProvider, encryption)).rejects.toMatchObject({ code: 'PROVIDER_REJECTED' });
    const [failed] = await db.select().from(paymentPayouts).where(eq(paymentPayouts.quoteId, rejectedQuote.id));
    expect(failed).toMatchObject({ payoutStatus: 'FAILED', actualDebitSatang: null });
    expect(await getWallet(rejectedStudent)).toMatchObject({ earningsBalanceSatang: 1_000, reservedForPayoutsSatang: 0 });

    const uncertainStudent = await createStudent('be115-uncertain');
    await creditEarnings(uncertainStudent, 1_000);
    const uncertainQuote = await quotePayout({ principalUserId: uncertainStudent, receiptSatang: positiveSatang(100) });
    const uncertainProvider = new FakePayoutProvider();
    uncertainProvider.mode = 'uncertain';
    const uncertainInput = {
      principalUserId: uncertainStudent,
      quoteId: uncertainQuote.id,
      idempotency: { key: 'be115-uncertain-1' },
    };
    await expect(initiatePayout(uncertainInput, uncertainProvider, encryption)).rejects.toMatchObject({ code: 'PROVIDER_UNCERTAIN' });
    const [awaiting] = await db.select().from(paymentPayouts).where(eq(paymentPayouts.quoteId, uncertainQuote.id));
    expect(awaiting?.payoutStatus).toBe('AWAITING_RECONCILIATION');
    expect(await getWallet(uncertainStudent)).toMatchObject({ earningsBalanceSatang: 900, reservedForPayoutsSatang: 100 });
    const retried = await initiatePayout(uncertainInput, uncertainProvider, encryption);
    expect(retried.payoutStatus).toBe('PENDING');
    expect(uncertainProvider.requests.map(({ internalReference }) => internalReference)).toEqual([
      retried.internalReference,
      retried.internalReference,
    ]);
  });

  it('releases the reserve when destination decryption fails before the Provider call', async () => {
    const studentId = await createStudent('be115-decryption-failure');
    await creditEarnings(studentId, 1_000);
    const quote = await quotePayout({ principalUserId: studentId, receiptSatang: positiveSatang(100) });
    const provider = new FakePayoutProvider();
    const unavailableKey = createPayoutDestinationEncryption({
      activeKeyVersion: 'v2',
      keys: { v2: 'v'.repeat(32) },
    });

    await expect(initiatePayout({
      principalUserId: studentId,
      quoteId: quote.id,
      idempotency: { key: 'be115-decryption-failure-1' },
    }, provider, unavailableKey)).rejects.toBeInstanceOf(PayoutDestinationEncryptionError);

    expect(provider.requests).toHaveLength(0);
    expect(await getWallet(studentId)).toMatchObject({
      earningsBalanceSatang: 1_000,
      reservedForPayoutsSatang: 0,
    });
    const [payout] = await db.select().from(paymentPayouts).where(eq(paymentPayouts.quoteId, quote.id));
    expect(payout).toMatchObject({
      payoutStatus: 'FAILED',
      finalLedgerTransactionId: expect.any(String),
    });
  });

  it('releases the reserve when the Provider is not configured', async () => {
    const studentId = await createStudent('be115-provider-configuration');
    await creditEarnings(studentId, 1_000);
    const quote = await quotePayout({ principalUserId: studentId, receiptSatang: positiveSatang(100) });
    const provider = new FakePayoutProvider();
    provider.mode = 'configuration';

    await expect(initiatePayout({
      principalUserId: studentId,
      quoteId: quote.id,
      idempotency: { key: 'be115-provider-configuration-1' },
    }, provider, encryption)).rejects.toMatchObject({ code: 'PROVIDER_CONFIGURATION' });

    expect(provider.requests).toHaveLength(0);
    expect(await getWallet(studentId)).toMatchObject({
      earningsBalanceSatang: 1_000,
      reservedForPayoutsSatang: 0,
    });
  });

  it('uses the retained Payout destination snapshot when retrying', async () => {
    const studentId = await createStudent('be115-snapshot');
    await creditEarnings(studentId, 1_000);
    const quote = await quotePayout({ principalUserId: studentId, receiptSatang: positiveSatang(100) });
    const provider = new FakePayoutProvider();
    provider.mode = 'uncertain';
    const input = {
      principalUserId: studentId,
      quoteId: quote.id,
      idempotency: { key: 'be115-snapshot-1' },
    };

    await expect(initiatePayout(input, provider, encryption)).rejects.toMatchObject({ code: 'PROVIDER_UNCERTAIN' });
    const [payout] = await db.select().from(paymentPayouts).where(eq(paymentPayouts.quoteId, quote.id));
    if (!payout) throw new Error('Missing Payout snapshot');
    const replacementSecret = encryption.encrypt('9999999999');
    await db.update(paymentPayoutAccounts)
      .set({
        accountNumberKeyVersion: replacementSecret.keyVersion,
        accountNumberNonce: replacementSecret.nonce,
        accountNumberCiphertext: replacementSecret.ciphertext,
        accountNumberAuthTag: replacementSecret.authTag,
      })
      .where(eq(paymentPayoutAccounts.id, payout.payoutAccountId));

    await initiatePayout(input, provider, encryption);

    expect(provider.requests.map(({ destination }) => destination.accountNumber)).toEqual([
      '1234567890',
      '1234567890',
    ]);
  });

  it('allows at most one active Payout per Student', async () => {
    const studentId = await createStudent('be115-active');
    await creditEarnings(studentId, 1_000);
    const first = await quotePayout({ principalUserId: studentId, receiptSatang: positiveSatang(100) });
    const second = await quotePayout({ principalUserId: studentId, receiptSatang: positiveSatang(100) });
    const provider = new FakePayoutProvider();
    await initiatePayout({ principalUserId: studentId, quoteId: first.id, idempotency: { key: 'be115-active-1' } }, provider, encryption);
    await expect(initiatePayout({ principalUserId: studentId, quoteId: second.id, idempotency: { key: 'be115-active-2' } }, provider, encryption))
      .rejects.toMatchObject({ code: 'PAYOUT_ACTIVE_EXISTS' });
  });

  it('rejects initiation for a non-active Wallet', async () => {
    const studentId = await createStudent('be115-wallet-status');
    const quote = await quotePayout({ principalUserId: studentId, receiptSatang: positiveSatang(100) });
    const wallet = await getWallet(studentId);
    await changeWalletStatus({
      walletId: wallet.id,
      toStatus: 'FROZEN',
      actorUserId: studentId,
      reason: 'Freeze Wallet for Payout test',
    });
    const provider = new FakePayoutProvider();

    await expect(quotePayout({ principalUserId: studentId, receiptSatang: positiveSatang(100) }))
      .rejects.toMatchObject({ code: 'WALLET_NOT_ACTIVE' });

    await expect(initiatePayout({
      principalUserId: studentId,
      quoteId: quote.id,
      idempotency: { key: 'be115-wallet-status-1' },
    }, provider, encryption)).rejects.toMatchObject({ code: 'WALLET_NOT_ACTIVE' });
    expect(provider.requests).toHaveLength(0);
  });

  it('rejects an expired Quote before reserving Earnings Balance', async () => {
    const studentId = await createStudent('be115-expired-quote');
    const quote = await quotePayout({ principalUserId: studentId, receiptSatang: positiveSatang(100) });
    await db.update(paymentPayoutQuotes)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(paymentPayoutQuotes.id, quote.id));
    const provider = new FakePayoutProvider();

    await expect(initiatePayout({
      principalUserId: studentId,
      quoteId: quote.id,
      idempotency: { key: 'be115-expired-quote-1' },
    }, provider, encryption)).rejects.toMatchObject({ code: 'PAYOUT_QUOTE_EXPIRED' });
    expect(provider.requests).toHaveLength(0);
  });

  it('rejects a consumed Quote on a new initiation attempt', async () => {
    const studentId = await createStudent('be115-consumed-quote');
    await creditEarnings(studentId, 1_000);
    const quote = await quotePayout({ principalUserId: studentId, receiptSatang: positiveSatang(100) });
    const provider = new FakePayoutProvider();
    provider.mode = 'rejected';

    await expect(initiatePayout({
      principalUserId: studentId,
      quoteId: quote.id,
      idempotency: { key: 'be115-consumed-quote-1' },
    }, provider, encryption)).rejects.toMatchObject({ code: 'PROVIDER_REJECTED' });
    await expect(initiatePayout({
      principalUserId: studentId,
      quoteId: quote.id,
      idempotency: { key: 'be115-consumed-quote-2' },
    }, provider, encryption)).rejects.toMatchObject({ code: 'PAYOUT_QUOTE_CONSUMED' });
  });

  it('serializes concurrent initiation attempts for one Student', async () => {
    const studentId = await createStudent('be115-concurrent');
    await creditEarnings(studentId, 1_000);
    const first = await quotePayout({ principalUserId: studentId, receiptSatang: positiveSatang(100) });
    const second = await quotePayout({ principalUserId: studentId, receiptSatang: positiveSatang(100) });
    const provider = new FakePayoutProvider();
    const results = await Promise.allSettled([
      initiatePayout({ principalUserId: studentId, quoteId: first.id, idempotency: { key: 'be115-concurrent-1' } }, provider, encryption),
      initiatePayout({ principalUserId: studentId, quoteId: second.id, idempotency: { key: 'be115-concurrent-2' } }, provider, encryption),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')?.reason)
      .toMatchObject({ code: 'PAYOUT_ACTIVE_EXISTS' });
    expect(provider.requests).toHaveLength(1);
  });

  it('does not leave a Payout row when reserve creation fails', async () => {
    const studentId = await createStudent('be115-atomic');
    const quote = await quotePayout({ principalUserId: studentId, receiptSatang: positiveSatang(100) });
    const provider = new FakePayoutProvider();
    await expect(initiatePayout({ principalUserId: studentId, quoteId: quote.id, idempotency: { key: 'be115-atomic-1' } }, provider, encryption))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_EARNINGS_BALANCE' });
    expect(await db.select().from(paymentPayouts).where(and(eq(paymentPayouts.userId, studentId), eq(paymentPayouts.quoteId, quote.id))))
      .toHaveLength(0);
    expect((await db.select().from(paymentPayoutQuotes).where(eq(paymentPayoutQuotes.id, quote.id)))[0]?.consumedAt)
      .toBeNull();
  });
});
