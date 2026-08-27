import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import {
  paymentPayoutStatusHistory,
  paymentProviderEventInbox,
} from '@/database/schema/payment.schema';
import {
  walletLedgerAccount,
  walletLedgerTransaction,
  walletWallet,
} from '@/database/schema/wallet.schema';
import {
  createPayoutDestinationEncryption,
  savePayoutDestination,
} from '@/modules/payout-destination';
import {
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
  listPayouts,
  PayoutProviderError,
  quotePayout,
  processPayoutProviderEvent,
  receivePayoutProviderEvent,
  reconcilePayout,
} from '@/modules/payout';
import type {
  OutboundPayoutProvider,
  OutboundPayoutRequest,
  OutboundPayoutResponse,
  OutboundPayoutStatusRequest,
  OutboundPayoutStatusResponse,
} from '@/modules/payout';

import { beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';

const encryption = createPayoutDestinationEncryption({
  activeKeyVersion: 'v1',
  keys: { v1: 'p'.repeat(32) },
});

class FakePayoutProvider implements OutboundPayoutProvider {
  constructor(private readonly uncertain = false) {}

  async createPayout(input: OutboundPayoutRequest): Promise<OutboundPayoutResponse> {
    if (this.uncertain) {
      throw new PayoutProviderError('PROVIDER_UNCERTAIN', 'Provider response is uncertain.');
    }
    return {
      providerReference: `po-${crypto.randomUUID()}`,
      providerStatus: 'ACCEPTED',
      providerAmountSatang: input.receiptSatang,
      actualFeeSatang: satang(0),
      actualTaxSatang: satang(0),
      actualDebitSatang: input.receiptSatang,
      providerApiVersion: 'test-v1',
    };
  }
}

const creditEarnings = async (studentId: string, amountSatang: number) => {
  const accounts = await db
    .select({ id: walletLedgerAccount.id, type: walletLedgerAccount.type })
    .from(walletLedgerAccount)
    .innerJoin(walletWallet, eq(walletLedgerAccount.walletId, walletWallet.id))
    .where(eq(walletWallet.userId, studentId));
  const [suspense] = await db
    .select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(eq(walletLedgerAccount.code, 'platform:PLATFORM_SUSPENSE'));
  const earnings = accounts.find((account) => account.type === 'EARNINGS');
  if (!earnings || !suspense) throw new Error('Wallet accounts were not provisioned.');
  await createSealedLedgerTransaction({
    businessReference: `be117-credit:${crypto.randomUUID()}`,
    eventType: 'ADJUSTMENT',
    postings: [
      { accountId: earnings.id, amountSatang: signedSatang(amountSatang) },
      { accountId: suspense.id, amountSatang: signedSatang(-amountSatang) },
    ],
  });
};

const createPendingPayout = async (prefix: string, provider = new FakePayoutProvider()) => {
  const userId = `${prefix}-${crypto.randomUUID()}`;
  await db.insert(authUser).values({
    id: userId,
    email: `${userId}@ku.th`,
    firstName: 'Payout',
    lastName: 'Event',
  });
  await ensureWallet(userId);
  await savePayoutDestination({
    principalUserId: userId,
    givenName: 'Payout',
    surname: 'Event',
    relationship: 'SELF',
    bankCode: 'SCB',
    accountNumber: '1234567890',
    accountHolderName: 'Payout Event',
    routingType: 'BANK_ACCOUNT',
    routingValue: '1234567890',
  }, encryption);
  await creditEarnings(userId, 1_000);
  const quote = await quotePayout({
    principalUserId: userId,
    receiptSatang: positiveSatang(100),
  });
  let payout;
  try {
    payout = await initiatePayout({
      principalUserId: userId,
      quoteId: quote.id,
      idempotency: { key: `${prefix}-${crypto.randomUUID()}` },
    }, provider, encryption);
  } catch (error: unknown) {
    if (!(error instanceof PayoutProviderError) || error.code !== 'PROVIDER_UNCERTAIN') throw error;
    [payout] = await listPayouts(userId, 1);
  }
  if (!payout) throw new Error('Payout was not created.');
  return { userId, payout };
};

const eventPayload = (input: {
  eventId: string;
  internalReference: string;
  providerReference: string;
  status: string;
  amount?: number;
  event?: string;
}) => JSON.stringify({
  event_id: input.eventId,
  event: input.event ?? `v3_payout.${input.status.toLowerCase()}`,
  data: {
    payout_id: input.providerReference,
    reference_id: input.internalReference,
    status: input.status,
    ...(input.amount === undefined ? {} : { source_amount: input.amount }),
    source_currency: 'THB',
    destination_currency: 'THB',
    updated: '2026-08-27T00:00:00.000Z',
  },
});

const receive = (rawPayload: string) => receivePayoutProviderEvent({
  rawPayload,
  callbackToken: 'be117-test-token',
  webhookToken: 'be117-test-token',
  encryption,
});

beforeAll(async () => {
  await sql`select 1`;
  await ensureInitialMoneyPolicy();
});

describe('Payout Provider event application services', () => {
  it('settles the reserved Payout exactly once after a confirmed success', async () => {
    const { userId, payout } = await createPendingPayout('be117-success');
    const rawPayload = eventPayload({
      eventId: `be117-success-${crypto.randomUUID()}`,
      internalReference: payout.internalReference,
      providerReference: payout.providerReference!,
      status: 'SUCCEEDED',
      amount: payout.principalSatang,
    });
    const [received, duplicate] = await Promise.all([receive(rawPayload), receive(rawPayload)]);
    expect(duplicate.id).toBe(received.id);

    const processed = await processPayoutProviderEvent(received.id);
    const replayed = await processPayoutProviderEvent(received.id);

    expect(processed.processingStatus).toBe('PROCESSED');
    expect(replayed.processingStatus).toBe('PROCESSED');
    expect(await getPayout(userId, payout.id)).toMatchObject({
      payoutStatus: 'COMPLETED',
      finalLedgerTransactionId: expect.any(String),
    });
    expect(await getWallet(userId)).toMatchObject({
      earningsBalanceSatang: 900,
      reservedForPayoutsSatang: 0,
    });
    expect(await db.select().from(walletLedgerTransaction).where(
      eq(walletLedgerTransaction.businessReference, `payout-settle:${payout.id}`),
    )).toHaveLength(1);
  });

  it('releases the full reserve for failure and does not regress terminal state', async () => {
    const { userId, payout } = await createPendingPayout('be117-failure');
    const failed = await receive(eventPayload({
      eventId: `be117-failed-${crypto.randomUUID()}`,
      internalReference: payout.internalReference,
      providerReference: payout.providerReference!,
      status: 'FAILED',
    }));
    const lateSuccess = await receive(eventPayload({
      eventId: `be117-late-success-${crypto.randomUUID()}`,
      internalReference: payout.internalReference,
      providerReference: payout.providerReference!,
      status: 'SUCCEEDED',
      amount: payout.principalSatang,
    }));

    await processPayoutProviderEvent(failed.id);
    await processPayoutProviderEvent(lateSuccess.id);

    expect(await getPayout(userId, payout.id)).toMatchObject({ payoutStatus: 'FAILED' });
    expect(await getWallet(userId)).toMatchObject({
      earningsBalanceSatang: 1_000,
      reservedForPayoutsSatang: 0,
    });
    expect(await db.select().from(paymentPayoutStatusHistory).where(
      eq(paymentPayoutStatusHistory.payoutId, payout.id),
    )).toContainEqual(expect.objectContaining({ fromStatus: 'PENDING', toStatus: 'FAILED' }));
  });

  it('reconciles an uncertain Payout through the provider status adapter', async () => {
    const { userId, payout } = await createPendingPayout(
      'be117-reconcile',
      new FakePayoutProvider(true),
    );
    let request: OutboundPayoutStatusRequest | undefined;
    const provider = {
      getPayoutStatus: async (input: OutboundPayoutStatusRequest): Promise<OutboundPayoutStatusResponse> => {
        request = input;
        return {
          providerReference: payout.providerReference!,
          providerStatus: 'SUCCEEDED',
          normalizedStatus: 'COMPLETED',
          providerAmountSatang: payout.principalSatang,
          actualFeeSatang: satang(0),
          actualTaxSatang: satang(0),
          actualDebitSatang: payout.principalSatang,
          providerApiVersion: 'test-v1',
          occurredAt: new Date('2026-08-27T00:00:00.000Z'),
        };
      },
    };

    const reconciled = await reconcilePayout(userId, payout.id, provider);

    expect(request).toMatchObject({
      providerReference: payout.providerReference,
      internalReference: payout.internalReference,
      expectedPrincipalSatang: payout.principalSatang,
      maximumDebitSatang: payout.maximumDebitSatang,
    });
    expect(reconciled).toMatchObject({ payoutStatus: 'COMPLETED' });
    expect(await getWallet(userId)).toMatchObject({ reservedForPayoutsSatang: 0 });
  });

  it('retains payout facts after the raw event payload is purged', async () => {
    const { payout } = await createPendingPayout('be117-retention');
    const event = await receive(eventPayload({
      eventId: `be117-retention-${crypto.randomUUID()}`,
      internalReference: payout.internalReference,
      providerReference: payout.providerReference!,
      status: 'SUCCEEDED',
      amount: payout.principalSatang,
    }));
    await processPayoutProviderEvent(event.id);
    const [stored] = await db.select().from(paymentProviderEventInbox)
      .where(eq(paymentProviderEventInbox.id, event.id));
    expect(stored).toMatchObject({
      resourceType: 'PAYOUT',
      normalizedStatus: 'COMPLETED',
      providerAmountSatang: payout.principalSatang,
      providerActualFeeSatang: 0,
      providerActualTaxSatang: 0,
      providerActualDebitSatang: payout.principalSatang,
      rawPayloadCiphertext: expect.any(String),
    });
  });
});
