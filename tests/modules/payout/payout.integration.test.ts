import { db, sql } from '@/database/client';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import {
  paymentPayoutAccounts,
  paymentPayouts,
  paymentPayoutQuotes,
} from '@/database/schema/payment.schema';
import {
  walletLedgerAccount,
  walletLedgerTransaction,
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
  approvePayout,
  getAdminPayout,
  initiatePayout,
  listAdminPayouts,
  listAdminPayoutStatusHistory,
  listPayoutStatusHistory,
  listPayouts,
  processApprovedPayout,
  quotePayout,
  rejectPayout,
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
        providerStatus: 400,
        providerMessage: 'Invalid destination account 1234567890.',
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

const createStudent = async (_prefix: string) => {
  const id = crypto.randomUUID();
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

const createAdmin = async () => {
  const id = crypto.randomUUID();
  await db.insert(authAdmin).values({
    id,
    email: `${id}@example.com`,
    firstName: 'Payout',
    lastName: 'Admin',
  });
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
  it('submits a Payout for Admin approval without calling the Provider', async () => {
    const studentId = await createStudent('be199-pending-approval');
    await creditEarnings(studentId, 10_000);
    const provider = new FakePayoutProvider();
    const quote = await quotePayout({ principalUserId: studentId, receiptSatang: positiveSatang(1_234) });

    const payout = await initiatePayout({
      principalUserId: studentId,
      quoteId: quote.id,
      idempotency: { key: 'be199-pending-approval-1' },
    });

    expect(payout).toMatchObject({
      payoutStatus: 'PENDING_ADMIN_APPROVAL',
      receiptSatang: 1_234,
      maximumDebitSatang: 1_234,
    });
    expect(provider.requests).toHaveLength(0);
    expect(await getWallet(studentId)).toMatchObject({
      earningsBalanceSatang: 8_766,
      reservedForPayoutsSatang: 1_234,
    });
  });

  it('allows an Admin to approve a waiting Payout exactly once', async () => {
    const studentId = await createStudent('be199-approval');
    const adminId = await createAdmin();
    await creditEarnings(studentId, 10_000);
    const payout = await initiatePayout({
      principalUserId: studentId,
      quoteId: (await quotePayout({ principalUserId: studentId, receiptSatang: positiveSatang(1_234) })).id,
      idempotency: { key: 'be199-approval-submit-1' },
    });

    const approved = await approvePayout(adminId, payout.id, {
      idempotencyKey: 'be199-approval-decision-1',
      note: 'Reviewed destination and amount',
    });
    const replay = await approvePayout(adminId, payout.id, {
      idempotencyKey: 'be199-approval-decision-1',
      note: 'Reviewed destination and amount',
    });
    await expect(approvePayout(adminId, payout.id, {
      idempotencyKey: 'be199-approval-decision-1',
      note: 'Different note',
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });

    expect(approved).toMatchObject({
      id: payout.id,
      payoutStatus: 'CREATING',
    });
    expect(replay).toEqual(approved);
    expect(await getWallet(studentId)).toMatchObject({
      earningsBalanceSatang: 8_766,
      reservedForPayoutsSatang: 1_234,
    });
    expect(await listPayoutStatusHistory(studentId, payout.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fromStatus: 'PENDING_ADMIN_APPROVAL',
        toStatus: 'CREATING',
        actorAdminId: adminId,
        reason: 'Reviewed destination and amount',
      }),
    ]));
  });

  it('allows an Admin to reject a waiting Payout and release the full Payout Reserve', async () => {
    const studentId = await createStudent('be199-rejection');
    const adminId = await createAdmin();
    await creditEarnings(studentId, 10_000);
    const quote = await quotePayout({ principalUserId: studentId, receiptSatang: positiveSatang(1_234) });
    const payout = await initiatePayout({
      principalUserId: studentId,
      quoteId: quote.id,
      idempotency: { key: 'be199-rejection-submit-1' },
    });
    await expect(rejectPayout(adminId, payout.id, {
      idempotencyKey: 'be199-rejection-missing-reason',
      reason: '   ',
    })).rejects.toMatchObject({ code: 'PAYOUT_REJECTION_REASON_REQUIRED' });

    const rejected = await rejectPayout(adminId, payout.id, {
      idempotencyKey: 'be199-rejection-decision-1',
      reason: 'Destination needs verification',
    });
    const replay = await rejectPayout(adminId, payout.id, {
      idempotencyKey: 'be199-rejection-decision-1',
      reason: 'Destination needs verification',
    });

    expect(rejected).toMatchObject({
      id: payout.id,
      payoutStatus: 'CANCELLED',
      finalLedgerTransactionId: expect.any(String),
    });
    expect(replay).toEqual(rejected);
    expect(await getWallet(studentId)).toMatchObject({
      earningsBalanceSatang: 10_000,
      reservedForPayoutsSatang: 0,
    });
    expect(await db.select().from(walletLedgerTransaction).where(
      eq(walletLedgerTransaction.businessReference, `payout-admin-rejection-release:${payout.id}`),
    )).toHaveLength(1);
    expect(await listPayoutStatusHistory(studentId, payout.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fromStatus: 'PENDING_ADMIN_APPROVAL',
        toStatus: 'CANCELLED',
        actorAdminId: adminId,
        reason: 'Destination needs verification',
      }),
    ]));
  });

  it('lets the Payout Worker call the Provider only after approval', async () => {
    const studentId = await createStudent('be199-worker');
    const adminId = await createAdmin();
    await creditEarnings(studentId, 10_000);
    const quote = await quotePayout({ principalUserId: studentId, receiptSatang: positiveSatang(1_234) });
    const provider = new FakePayoutProvider();
    const payout = await initiatePayout({
      principalUserId: studentId,
      quoteId: quote.id,
      idempotency: { key: 'be199-worker-submit-1' },
    });

    expect(provider.requests).toHaveLength(0);
    await approvePayout(adminId, payout.id, { idempotencyKey: 'be199-worker-approval-1' });
    const processed = await processApprovedPayout(payout.id, provider, encryption);

    expect(processed).toMatchObject({
      id: payout.id,
      payoutStatus: 'PENDING',
      providerReference: `${provider.referencePrefix}-1`,
    });
    expect(provider.requests).toHaveLength(1);
  });

  it('claims an approved Payout so concurrent Worker retries submit once', async () => {
    const studentId = await createStudent('be199-worker-retry');
    const adminId = await createAdmin();
    await creditEarnings(studentId, 10_000);
    const quote = await quotePayout({ principalUserId: studentId, receiptSatang: positiveSatang(1_234) });
    const payout = await initiatePayout({
      principalUserId: studentId,
      quoteId: quote.id,
      idempotency: { key: 'be199-worker-retry-submit-1' },
    });
    await approvePayout(adminId, payout.id, { idempotencyKey: 'be199-worker-retry-approval-1' });

    const requests: OutboundPayoutRequest[] = [];
    let markStarted = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseProvider = () => {};
    const released = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const provider: OutboundPayoutProvider = {
      createPayout: async (input) => {
        requests.push(input);
        markStarted();
        await released;
        return {
          providerReference: `worker-retry-${payout.id}`,
          providerStatus: 'ACCEPTED',
          providerAmountSatang: input.receiptSatang,
          actualFeeSatang: satang(0),
          actualTaxSatang: satang(0),
          actualDebitSatang: input.receiptSatang,
          providerApiVersion: 'test-v1',
        };
      },
    };

    const first = processApprovedPayout(payout.id, provider, encryption);
    await started;
    const second = await processApprovedPayout(payout.id, provider, encryption);
    releaseProvider();
    const processed = await first;
    const replay = await processApprovedPayout(payout.id, provider, encryption);

    expect(second.payoutStatus).toBe('CREATING');
    expect(processed.payoutStatus).toBe('PENDING');
    expect(replay).toEqual(processed);
    expect(requests).toHaveLength(1);
  });

  it('does not submit a CREATING Payout without an Admin approval record', async () => {
    const studentId = await createStudent('be199-worker-unapproved');
    await creditEarnings(studentId, 10_000);
    const quote = await quotePayout({ principalUserId: studentId, receiptSatang: positiveSatang(1_234) });
    const payout = await initiatePayout({
      principalUserId: studentId,
      quoteId: quote.id,
      idempotency: { key: 'be199-worker-unapproved-submit-1' },
    });
    await db.update(paymentPayouts)
      .set({ payoutStatus: 'CREATING' })
      .where(eq(paymentPayouts.id, payout.id));
    const provider = new FakePayoutProvider();

    const result = await processApprovedPayout(payout.id, provider, encryption);

    expect(result.payoutStatus).toBe('CREATING');
    expect(provider.requests).toHaveLength(0);
  });

  it('returns not found for Admin history of an unknown Payout', async () => {
    await expect(listAdminPayoutStatusHistory(crypto.randomUUID()))
      .rejects.toMatchObject({ code: 'PAYOUT_NOT_FOUND' });
  });

  it('lists waiting Payouts for Admin review with masked destination data', async () => {
    const studentId = await createStudent('be199-admin-read');
    await creditEarnings(studentId, 10_000);
    const quote = await quotePayout({ principalUserId: studentId, receiptSatang: positiveSatang(1_234) });
    const payout = await initiatePayout({
      principalUserId: studentId,
      quoteId: quote.id,
      idempotency: { key: 'be199-admin-read-submit-1' },
    });

    const queue = await listAdminPayouts({ limit: 50 });
    const listed = queue.items.find((item) => item.id === payout.id);
    const detail = await getAdminPayout(payout.id);
    if (!listed) throw new Error('Waiting Payout was not listed for Admin review.');

    expect(listed).toMatchObject({
      id: payout.id,
      payoutStatus: 'PENDING_ADMIN_APPROVAL',
      bankCode: 'SCB',
      bankName: 'Siam Commercial Bank',
      destinationType: 'BANK_ACCOUNT',
      maskedDestinationValue: '****7890',
      maskedRoutingValue: '****7890',
      student: { id: studentId },
    });
    expect(detail).toEqual(listed);
  });

  it('quotes, reserves Earnings Balance, and initiates one Payout', async () => {
    const studentId = await createStudent('be115-success');
    const adminId = await createAdmin();
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

    const submitted = await initiatePayout({
      principalUserId: studentId,
      quoteId: quote.id,
      idempotency: { key: 'be115-success-1' },
    });

    expect(submitted.payoutStatus).toBe('PENDING_ADMIN_APPROVAL');
    expect(provider.requests).toHaveLength(0);
    await approvePayout(adminId, submitted.id, { idempotencyKey: 'be115-success-approval-1' });
    const payout = await processApprovedPayout(submitted.id, provider, encryption);

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
    })).toEqual(payout);
    expect(await getPayout(studentId, payout.id)).toEqual(payout);
    expect(await listPayouts(studentId)).toHaveLength(1);
    expect(await listPayoutStatusHistory(studentId, payout.id)).toMatchObject([
      { fromStatus: null, toStatus: 'PENDING_ADMIN_APPROVAL', source: 'INITIATION' },
      { fromStatus: 'PENDING_ADMIN_APPROVAL', toStatus: 'CREATING', source: 'ADMIN_APPROVAL' },
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
    })).rejects.toMatchObject({ code: 'PAYOUT_QUOTE_NOT_FOUND' });
    await expect(initiatePayout({
      principalUserId: ownerId,
      quoteId: quote.id,
      idempotency: { key: 'be115-owner-insufficient' },
    })).rejects.toMatchObject({ code: 'INSUFFICIENT_EARNINGS_BALANCE' });
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
    const rejectedAdmin = await createAdmin();
    await creditEarnings(rejectedStudent, 1_000);
    const rejectedQuote = await quotePayout({ principalUserId: rejectedStudent, receiptSatang: positiveSatang(100) });
    const rejectedProvider = new FakePayoutProvider();
    rejectedProvider.mode = 'rejected';

    const rejectedPayout = await initiatePayout({
      principalUserId: rejectedStudent,
      quoteId: rejectedQuote.id,
      idempotency: { key: 'be115-rejected-1' },
    });
    await approvePayout(rejectedAdmin, rejectedPayout.id, { idempotencyKey: 'be115-rejected-approval-1' });
    await expect(processApprovedPayout(rejectedPayout.id, rejectedProvider, encryption))
      .rejects.toMatchObject({ code: 'PROVIDER_REJECTED' });
    const [failed] = await db.select().from(paymentPayouts).where(eq(paymentPayouts.quoteId, rejectedQuote.id));
    expect(failed).toMatchObject({ payoutStatus: 'FAILED', actualDebitSatang: null });
    expect(failed?.providerStatus).toBe('400:TEST_REJECTED');
    const rejectedHistory = await listPayoutStatusHistory(rejectedStudent, rejectedPayout.id);
    expect(rejectedHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({
        toStatus: 'FAILED',
        providerStatus: '400:TEST_REJECTED',
        reason: 'Provider rejected the Payout.',
      }),
    ]));
    expect(JSON.stringify(rejectedHistory)).not.toContain('Invalid destination account');
    const adminRejectedHistory = await listAdminPayoutStatusHistory(rejectedPayout.id);
    expect(adminRejectedHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({
        toStatus: 'FAILED',
        providerStatus: '400:TEST_REJECTED',
        reason: 'Provider rejected the Payout. HTTP 400. Code TEST_REJECTED. Message: Invalid destination account <REDACTED>.',
      }),
    ]));
    expect(await getWallet(rejectedStudent)).toMatchObject({ earningsBalanceSatang: 1_000, reservedForPayoutsSatang: 0 });

    const uncertainStudent = await createStudent('be115-uncertain');
    const uncertainAdmin = await createAdmin();
    await creditEarnings(uncertainStudent, 1_000);
    const uncertainQuote = await quotePayout({ principalUserId: uncertainStudent, receiptSatang: positiveSatang(100) });
    const uncertainProvider = new FakePayoutProvider();
    uncertainProvider.mode = 'uncertain';
    const uncertainInput = {
      principalUserId: uncertainStudent,
      quoteId: uncertainQuote.id,
      idempotency: { key: 'be115-uncertain-1' },
    };
    const uncertainPayout = await initiatePayout(uncertainInput);
    await approvePayout(uncertainAdmin, uncertainPayout.id, { idempotencyKey: 'be115-uncertain-approval-1' });
    await expect(processApprovedPayout(uncertainPayout.id, uncertainProvider, encryption))
      .rejects.toMatchObject({ code: 'PROVIDER_UNCERTAIN' });
    const [awaiting] = await db.select().from(paymentPayouts).where(eq(paymentPayouts.quoteId, uncertainQuote.id));
    expect(awaiting?.payoutStatus).toBe('AWAITING_RECONCILIATION');
    expect(await getWallet(uncertainStudent)).toMatchObject({ earningsBalanceSatang: 900, reservedForPayoutsSatang: 100 });
    expect(uncertainProvider.requests.map(({ internalReference }) => internalReference)).toEqual([
      uncertainPayout.internalReference,
    ]);
  });

  it('releases the reserve when destination decryption fails before the Provider call', async () => {
    const studentId = await createStudent('be115-decryption-failure');
    const adminId = await createAdmin();
    await creditEarnings(studentId, 1_000);
    const quote = await quotePayout({ principalUserId: studentId, receiptSatang: positiveSatang(100) });
    const provider = new FakePayoutProvider();
    const unavailableKey = createPayoutDestinationEncryption({
      activeKeyVersion: 'v2',
      keys: { v2: 'v'.repeat(32) },
    });

    const submittedPayout = await initiatePayout({
      principalUserId: studentId,
      quoteId: quote.id,
      idempotency: { key: 'be115-decryption-failure-1' },
    });
    await approvePayout(adminId, submittedPayout.id, { idempotencyKey: 'be115-decryption-failure-approval-1' });
    await expect(processApprovedPayout(submittedPayout.id, provider, unavailableKey))
      .rejects.toBeInstanceOf(PayoutDestinationEncryptionError);

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
    const adminId = await createAdmin();
    await creditEarnings(studentId, 1_000);
    const quote = await quotePayout({ principalUserId: studentId, receiptSatang: positiveSatang(100) });
    const provider = new FakePayoutProvider();
    provider.mode = 'configuration';

    const payout = await initiatePayout({
      principalUserId: studentId,
      quoteId: quote.id,
      idempotency: { key: 'be115-provider-configuration-1' },
    });
    await approvePayout(adminId, payout.id, { idempotencyKey: 'be115-provider-configuration-approval-1' });
    await expect(processApprovedPayout(payout.id, provider, encryption))
      .rejects.toMatchObject({ code: 'PROVIDER_CONFIGURATION' });

    expect(provider.requests).toHaveLength(0);
    expect(await getWallet(studentId)).toMatchObject({
      earningsBalanceSatang: 1_000,
      reservedForPayoutsSatang: 0,
    });
  });

  it('uses the retained Payout destination snapshot when the Worker submits', async () => {
    const studentId = await createStudent('be115-snapshot');
    const adminId = await createAdmin();
    await creditEarnings(studentId, 1_000);
    const quote = await quotePayout({ principalUserId: studentId, receiptSatang: positiveSatang(100) });
    const provider = new FakePayoutProvider();
    const payout = await initiatePayout({
      principalUserId: studentId,
      quoteId: quote.id,
      idempotency: { key: 'be115-snapshot-1' },
    });
    const [payoutRecord] = await db.select().from(paymentPayouts).where(eq(paymentPayouts.id, payout.id));
    if (!payoutRecord) throw new Error('Missing Payout snapshot');
    const replacementSecret = encryption.encrypt('9999999999');
    await db.update(paymentPayoutAccounts)
      .set({
        accountNumberKeyVersion: replacementSecret.keyVersion,
        accountNumberNonce: replacementSecret.nonce,
        accountNumberCiphertext: replacementSecret.ciphertext,
        accountNumberAuthTag: replacementSecret.authTag,
      })
      .where(eq(paymentPayoutAccounts.id, payoutRecord.payoutAccountId));

    await approvePayout(adminId, payout.id, { idempotencyKey: 'be115-snapshot-approval-1' });
    await processApprovedPayout(payout.id, provider, encryption);

    expect(provider.requests.map(({ destination }) => destination.accountNumber)).toEqual([
      '1234567890',
    ]);
  });

  it('allows at most one active Payout per Student', async () => {
    const studentId = await createStudent('be115-active');
    await creditEarnings(studentId, 1_000);
    const first = await quotePayout({ principalUserId: studentId, receiptSatang: positiveSatang(100) });
    const second = await quotePayout({ principalUserId: studentId, receiptSatang: positiveSatang(100) });
    await initiatePayout({ principalUserId: studentId, quoteId: first.id, idempotency: { key: 'be115-active-1' } });
    await expect(initiatePayout({ principalUserId: studentId, quoteId: second.id, idempotency: { key: 'be115-active-2' } }))
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
    })).rejects.toMatchObject({ code: 'WALLET_NOT_ACTIVE' });
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
    })).rejects.toMatchObject({ code: 'PAYOUT_QUOTE_EXPIRED' });
    expect(provider.requests).toHaveLength(0);
  });

  it('rejects a consumed Quote on a new initiation attempt', async () => {
    const studentId = await createStudent('be115-consumed-quote');
    const adminId = await createAdmin();
    await creditEarnings(studentId, 1_000);
    const quote = await quotePayout({ principalUserId: studentId, receiptSatang: positiveSatang(100) });

    const payout = await initiatePayout({
      principalUserId: studentId,
      quoteId: quote.id,
      idempotency: { key: 'be115-consumed-quote-1' },
    });
    await rejectPayout(adminId, payout.id, {
      idempotencyKey: 'be115-consumed-quote-rejection-1',
      reason: 'Test rejection',
    });
    await expect(initiatePayout({
      principalUserId: studentId,
      quoteId: quote.id,
      idempotency: { key: 'be115-consumed-quote-2' },
    })).rejects.toMatchObject({ code: 'PAYOUT_QUOTE_CONSUMED' });
  });

  it('serializes concurrent initiation attempts for one Student', async () => {
    const studentId = await createStudent('be115-concurrent');
    await creditEarnings(studentId, 1_000);
    const first = await quotePayout({ principalUserId: studentId, receiptSatang: positiveSatang(100) });
    const second = await quotePayout({ principalUserId: studentId, receiptSatang: positiveSatang(100) });
    const provider = new FakePayoutProvider();
    const results = await Promise.allSettled([
      initiatePayout({ principalUserId: studentId, quoteId: first.id, idempotency: { key: 'be115-concurrent-1' } }),
      initiatePayout({ principalUserId: studentId, quoteId: second.id, idempotency: { key: 'be115-concurrent-2' } }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')?.reason)
      .toMatchObject({ code: 'PAYOUT_ACTIVE_EXISTS' });
    expect(provider.requests).toHaveLength(0);
  });

  it('does not leave a Payout row when reserve creation fails', async () => {
    const studentId = await createStudent('be115-atomic');
    const quote = await quotePayout({ principalUserId: studentId, receiptSatang: positiveSatang(100) });
    await expect(initiatePayout({ principalUserId: studentId, quoteId: quote.id, idempotency: { key: 'be115-atomic-1' } }))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_EARNINGS_BALANCE' });
    expect(await db.select().from(paymentPayouts).where(and(eq(paymentPayouts.userId, studentId), eq(paymentPayouts.quoteId, quote.id))))
      .toHaveLength(0);
    expect((await db.select().from(paymentPayoutQuotes).where(eq(paymentPayoutQuotes.id, quote.id)))[0]?.consumedAt)
      .toBeNull();
  });
});
