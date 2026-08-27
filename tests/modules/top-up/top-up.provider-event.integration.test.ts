import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import {
  paymentProviderEventHistory,
  paymentProviderEventInbox,
  paymentTopUp,
  paymentTopUpStatusHistory,
} from '@/database/schema/payment.schema';
import {
  walletLedgerTransaction,
  walletWallet,
} from '@/database/schema/wallet.schema';
import {
  createProviderEventEncryption,
  getTopUp,
  initiateTopUp,
  claimTopUpProviderEvents,
  listTopUpProviderEventHistory,
  processTopUpProviderEvent,
  purgeExpiredProviderEventPayloads,
  quoteTopUp,
  receiveTopUpProviderEvent,
  reconcileTopUp,
  retryTopUpProviderEvent,
} from '@/modules/top-up';
import {
  ensureInitialMoneyPolicy,
  ensureWallet,
  getWallet,
  positiveSatang,
} from '@/modules/wallet';
import type {
  InboundPaymentProvider,
  InboundPaymentReconciliationProvider,
  InboundPaymentRequest,
  InboundPaymentResponse,
  InboundPaymentStatusRequest,
  InboundPaymentStatusResponse,
} from '@/modules/top-up';

import { beforeAll, describe, expect, it } from 'bun:test';
import { and, asc, eq } from 'drizzle-orm';

class FakeInboundPaymentProvider implements InboundPaymentProvider {
  async createPayment(input: InboundPaymentRequest): Promise<InboundPaymentResponse> {
    return {
      providerReference: `be116-pr-${crypto.randomUUID()}`,
      providerStatus: 'REQUIRES_ACTION',
      providerAmountSatang: input.paymentTotalSatang,
      providerApiVersion: 'test-v1',
      providerChannelCode: 'QRPROMPTPAY',
      qrPayload: 'test-qr',
      qrExpiresAt: input.expiresAt,
    };
  }
}

const encryption = createProviderEventEncryption({
  activeKeyVersion: 'v1',
  keys: { v1: 'a'.repeat(32) },
});

const createPendingTopUp = async (prefix: string) => {
  const userId = `${prefix}-${crypto.randomUUID()}`;
  await db.insert(authUser).values({
    id: userId,
    email: `${userId}@ku.th`,
    firstName: 'Top-up',
    lastName: 'Integration',
  });
  await ensureWallet(userId);
  const quote = await quoteTopUp({
    principalUserId: userId,
    creditSatang: positiveSatang(100),
  });
  const topUp = await initiateTopUp({
    principalUserId: userId,
    quoteId: quote.id,
    idempotency: { key: `${prefix}-${crypto.randomUUID()}` },
  }, new FakeInboundPaymentProvider());
  return { userId, topUp };
};

const eventPayload = (input: {
  eventId: string;
  internalReference: string;
  providerReference: string;
  status: string;
  amount?: number;
  updatedAt?: string;
}) => JSON.stringify({
  event_id: input.eventId,
  event: input.status === 'FAILED' ? 'payment.failure' : 'payment.capture',
  data: {
    reference_id: input.internalReference,
    payment_request_id: input.providerReference,
    status: input.status,
    ...(input.amount === undefined ? {} : { request_amount: input.amount }),
    channel_code: 'QRPROMPTPAY',
    updated: input.updatedAt ?? '2026-08-27T00:00:00.000Z',
  },
});

const receive = (rawPayload: string, receivedAt?: Date) => receiveTopUpProviderEvent({
  rawPayload,
  callbackToken: 'be116-test-token',
  webhookToken: 'be116-test-token',
  receivedAt,
  encryption,
});

beforeAll(async () => {
  await sql`select 1`;
  await ensureInitialMoneyPolicy();
});

describe('Top-up Provider event application services', () => {
  it('stores webhook outcomes and credits the Spending Balance exactly once', async () => {
    const { userId, topUp } = await createPendingTopUp('be116-exact-once');
    const rawPayload = eventPayload({
      eventId: `be116-paid-${crypto.randomUUID()}`,
      internalReference: topUp.internalReference,
      providerReference: topUp.providerReference!,
      status: 'SUCCEEDED',
      amount: topUp.paymentTotalSatang / 100,
    });

    const [received, duplicate] = await Promise.all([
      receive(rawPayload),
      receive(rawPayload),
    ]);
    expect(duplicate.id).toBe(received.id);
    await expect(receive(rawPayload.replace('SUCCEEDED', 'PAID'))).rejects.toMatchObject({
      code: 'PROVIDER_EVENT_CONFLICT',
    });
    expect(received.rawPayloadAvailable).toBe(true);
    expect(await getWallet(userId)).toMatchObject({ spendingBalanceSatang: 0 });

    const processed = await processTopUpProviderEvent(received.id);
    const replayed = await processTopUpProviderEvent(received.id);
    expect(processed.processingStatus).toBe('PROCESSED');
    expect(replayed.processingStatus).toBe('PROCESSED');
    expect(await getTopUp(userId, topUp.id)).toMatchObject({
      topUpStatus: 'PAID',
      creditedLedgerTransactionId: expect.any(String),
    });
    expect(await getWallet(userId)).toMatchObject({
      spendingBalanceSatang: topUp.creditSatang,
    });
    expect(await db.select().from(walletLedgerTransaction).where(
      eq(walletLedgerTransaction.businessReference, `top-up-credit:${topUp.id}`),
    )).toHaveLength(1);
    expect(await listTopUpProviderEventHistory(received.id)).toMatchObject([
      { fromStatus: null, toStatus: 'RECEIVED' },
      { fromStatus: 'RECEIVED', toStatus: 'PROCESSING' },
      { fromStatus: 'PROCESSING', toStatus: 'PROCESSED' },
    ]);
  });

  it('does not duplicate a ledger credit when workers process one event concurrently', async () => {
    const { userId, topUp } = await createPendingTopUp('be116-concurrent-process');
    const event = await receive(eventPayload({
      eventId: `be116-concurrent-${crypto.randomUUID()}`,
      internalReference: topUp.internalReference,
      providerReference: topUp.providerReference!,
      status: 'SUCCEEDED',
      amount: topUp.paymentTotalSatang / 100,
    }));

    const results = await Promise.allSettled([
      processTopUpProviderEvent(event.id),
      processTopUpProviderEvent(event.id),
    ]);

    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    expect(await getTopUp(userId, topUp.id)).toMatchObject({ topUpStatus: 'PAID' });
    expect(await db.select().from(walletLedgerTransaction).where(
      eq(walletLedgerTransaction.businessReference, `top-up-credit:${topUp.id}`),
    )).toHaveLength(1);
  });

  it('does not regress a terminal Top-up when events arrive out of order', async () => {
    const { userId, topUp } = await createPendingTopUp('be116-order');
    const failed = await receive(eventPayload({
      eventId: `be116-failed-${crypto.randomUUID()}`,
      internalReference: topUp.internalReference,
      providerReference: topUp.providerReference!,
      status: 'FAILED',
    }));
    const paid = await receive(eventPayload({
      eventId: `be116-paid-${crypto.randomUUID()}`,
      internalReference: topUp.internalReference,
      providerReference: topUp.providerReference!,
      status: 'SUCCEEDED',
      amount: topUp.paymentTotalSatang / 100,
    }));

    await processTopUpProviderEvent(failed.id);
    await processTopUpProviderEvent(paid.id);

    expect(await getTopUp(userId, topUp.id)).toMatchObject({ topUpStatus: 'FAILED' });
    expect(await getWallet(userId)).toMatchObject({ spendingBalanceSatang: 0 });
    expect(await db.select().from(paymentTopUpStatusHistory).where(
      eq(paymentTopUpStatusHistory.topUpId, topUp.id),
    ).orderBy(
      asc(paymentTopUpStatusHistory.occurredAt),
      asc(paymentTopUpStatusHistory.id),
    )).toMatchObject([
      { fromStatus: null, toStatus: 'PENDING' },
      { fromStatus: 'PENDING', toStatus: 'FAILED' },
    ]);
  });

  it('records a Provider reversal as a linked ledger correction', async () => {
    const { userId, topUp } = await createPendingTopUp('be116-correction');
    const paid = await receive(eventPayload({
      eventId: `be116-paid-${crypto.randomUUID()}`,
      internalReference: topUp.internalReference,
      providerReference: topUp.providerReference!,
      status: 'SUCCEEDED',
      amount: topUp.paymentTotalSatang / 100,
    }));
    await processTopUpProviderEvent(paid.id);
    const [credit] = await db.select().from(walletLedgerTransaction).where(
      eq(walletLedgerTransaction.businessReference, `top-up-credit:${topUp.id}`),
    );
    if (!credit) throw new Error('Top-up credit ledger transaction was not created.');

    const reversed = await receive(eventPayload({
      eventId: `be116-reversed-${crypto.randomUUID()}`,
      internalReference: topUp.internalReference,
      providerReference: topUp.providerReference!,
      status: 'REVERSED',
    }));
    await processTopUpProviderEvent(reversed.id);

    expect(await getTopUp(userId, topUp.id)).toMatchObject({ topUpStatus: 'PAID' });
    expect(await getWallet(userId)).toMatchObject({ spendingBalanceSatang: 0 });
    expect(await db.select().from(walletLedgerTransaction).where(and(
      eq(walletLedgerTransaction.correctionOfTransactionId, credit.id),
      eq(walletLedgerTransaction.businessReference, `top-up-reversal:${topUp.id}`),
    ))).toHaveLength(1);
  });

  it('credits a confirmed Top-up while the Wallet is not Active', async () => {
    const { userId, topUp } = await createPendingTopUp('be116-wallet-state');
    const [wallet] = await db.select().from(walletWallet).where(eq(walletWallet.userId, userId));
    if (!wallet) throw new Error('Wallet was not provisioned.');
    await db.update(walletWallet)
      .set({ walletStatus: 'FROZEN' })
      .where(eq(walletWallet.id, wallet.id));

    const event = await receive(eventPayload({
      eventId: `be116-frozen-${crypto.randomUUID()}`,
      internalReference: topUp.internalReference,
      providerReference: topUp.providerReference!,
      status: 'SUCCEEDED',
      amount: topUp.paymentTotalSatang / 100,
    }));
    await processTopUpProviderEvent(event.id);

    expect(await getTopUp(userId, topUp.id)).toMatchObject({ topUpStatus: 'PAID' });
    expect(await getWallet(userId)).toMatchObject({
      walletStatus: 'FROZEN',
      spendingBalanceSatang: topUp.creditSatang,
    });
  });

  it('retries unknown Top-ups and retains encrypted payloads until expiry', async () => {
    const receivedAt = new Date('2026-01-01T00:00:00.000Z');
    const rawPayload = eventPayload({
      eventId: `be116-retry-${crypto.randomUUID()}`,
      internalReference: `missing-${crypto.randomUUID()}`,
      providerReference: `missing-provider-${crypto.randomUUID()}`,
      status: 'REQUIRES_ACTION',
      updatedAt: receivedAt.toISOString(),
    });
    const event = await receive(rawPayload, receivedAt);

    await expect(processTopUpProviderEvent(event.id)).rejects.toMatchObject({
      code: 'PROVIDER_EVENT_NOT_FOUND',
    });
    const [retryable] = await db.select().from(paymentProviderEventInbox)
      .where(eq(paymentProviderEventInbox.id, event.id));
    expect(retryable).toMatchObject({ processingStatus: 'RETRYABLE', attemptCount: 1 });
    await expect(retryTopUpProviderEvent(event.id)).resolves.toMatchObject({
      processingStatus: 'RECEIVED',
    });
    await expect(processTopUpProviderEvent(event.id)).rejects.toMatchObject({
      code: 'PROVIDER_EVENT_NOT_FOUND',
    });

    const [stored] = await db.select().from(paymentProviderEventInbox)
      .where(eq(paymentProviderEventInbox.id, event.id));
    expect(stored?.payloadHash).toHaveLength(64);
    expect(stored?.rawPayloadCiphertext).not.toBe(rawPayload);
    expect(stored?.rawPayloadCiphertext).toBeTruthy();

    expect(await purgeExpiredProviderEventPayloads(
      new Date('2026-01-31T00:00:00.000Z'),
    )).toBeGreaterThanOrEqual(1);
    const [purged] = await db.select().from(paymentProviderEventInbox)
      .where(eq(paymentProviderEventInbox.id, event.id));
    expect(purged).toMatchObject({
      rawPayloadKeyVersion: null,
      rawPayloadNonce: null,
      rawPayloadCiphertext: null,
      rawPayloadAuthTag: null,
    });
    await expect(db.delete(paymentProviderEventInbox).where(eq(paymentProviderEventInbox.id, event.id)).execute())
      .rejects.toThrow();
    expect(await db.select().from(paymentProviderEventHistory).where(
      eq(paymentProviderEventHistory.eventId, event.id),
    )).toHaveLength(6);
  });

  it('recovers stale claims and moves exhausted events to the dead-letter state', async () => {
    const now = new Date('2026-08-27T00:10:00.000Z');
    const staleClaimedAt = new Date('2026-08-27T00:00:00.000Z');
    const staleEvent = await receive(eventPayload({
      eventId: `be116-stale-${crypto.randomUUID()}`,
      internalReference: `missing-${crypto.randomUUID()}`,
      providerReference: `missing-provider-${crypto.randomUUID()}`,
      status: 'REQUIRES_ACTION',
    }));

    await db.update(paymentProviderEventInbox)
      .set({ processingStatus: 'PROCESSING', attemptCount: 1, claimedAt: staleClaimedAt })
      .where(eq(paymentProviderEventInbox.id, staleEvent.id));

    await expect(processTopUpProviderEvent(staleEvent.id, now)).rejects.toMatchObject({
      code: 'PROVIDER_EVENT_NOT_FOUND',
    });
    const [recovered] = await db.select().from(paymentProviderEventInbox)
      .where(eq(paymentProviderEventInbox.id, staleEvent.id));
    expect(recovered).toMatchObject({ processingStatus: 'RETRYABLE', attemptCount: 2 });

    const deadEvent = await receive(eventPayload({
      eventId: `be116-dead-${crypto.randomUUID()}`,
      internalReference: `missing-${crypto.randomUUID()}`,
      providerReference: `missing-provider-${crypto.randomUUID()}`,
      status: 'REQUIRES_ACTION',
    }));
    await db.update(paymentProviderEventInbox)
      .set({ processingStatus: 'PROCESSING', attemptCount: 5, claimedAt: staleClaimedAt })
      .where(eq(paymentProviderEventInbox.id, deadEvent.id));

    await expect(claimTopUpProviderEvents({ now, eventId: deadEvent.id })).resolves.toEqual([]);
    const [dead] = await db.select().from(paymentProviderEventInbox)
      .where(eq(paymentProviderEventInbox.id, deadEvent.id));
    expect(dead).toMatchObject({
      processingStatus: 'DEAD_LETTER',
      attemptCount: 5,
      claimedAt: null,
      lastError: 'PROVIDER_EVENT_MAX_ATTEMPTS',
    });
    const history = await listTopUpProviderEventHistory(deadEvent.id);
    expect(history[history.length - 1]).toMatchObject({
      fromStatus: 'PROCESSING',
      toStatus: 'DEAD_LETTER',
      error: 'PROVIDER_EVENT_MAX_ATTEMPTS',
    });
  });

  it('reconciles an uncertain Top-up through the Provider status adapter', async () => {
    const { userId, topUp } = await createPendingTopUp('be116-reconcile');
    let request: InboundPaymentStatusRequest | undefined;
    const provider: InboundPaymentReconciliationProvider = {
      getPaymentStatus: async (input): Promise<InboundPaymentStatusResponse> => {
        request = input;
        return {
          providerReference: topUp.providerReference!,
          providerStatus: 'SUCCEEDED',
          normalizedStatus: 'PAID',
          providerAmountSatang: topUp.paymentTotalSatang,
          providerApiVersion: 'test-v1',
          providerChannelCode: 'QRPROMPTPAY',
          occurredAt: new Date('2026-08-27T00:00:00.000Z'),
        };
      },
    };

    const reconciled = await reconcileTopUp(userId, topUp.id, provider);
    expect(request).toMatchObject({
      providerReference: topUp.providerReference,
      internalReference: topUp.internalReference,
      expectedPaymentTotalSatang: topUp.paymentTotalSatang,
    });
    expect(reconciled).toMatchObject({ topUpStatus: 'PAID' });
    expect(await getWallet(userId)).toMatchObject({
      spendingBalanceSatang: topUp.creditSatang,
    });
  });

  it('reconciles an uncertain Top-up by internal reference when Provider reference is missing', async () => {
    const { userId, topUp } = await createPendingTopUp('be116-reconcile-by-internal-reference');
    await db.update(paymentTopUp)
      .set({ providerReference: null })
      .where(eq(paymentTopUp.id, topUp.id));
    let request: InboundPaymentStatusRequest | undefined;
    const provider: InboundPaymentReconciliationProvider = {
      getPaymentStatus: async (input): Promise<InboundPaymentStatusResponse> => {
        request = input;
        return {
          providerReference: 'be116-recovered-provider-reference',
          providerStatus: 'SUCCEEDED',
          normalizedStatus: 'PAID',
          providerAmountSatang: topUp.paymentTotalSatang,
          providerApiVersion: 'test-v1',
          providerChannelCode: 'QRPROMPTPAY',
          occurredAt: new Date('2026-08-27T00:00:00.000Z'),
        };
      },
    };

    const reconciled = await reconcileTopUp(userId, topUp.id, provider);
    expect(request).toMatchObject({
      providerReference: null,
      internalReference: topUp.internalReference,
      expectedPaymentTotalSatang: topUp.paymentTotalSatang,
    });
    expect(reconciled).toMatchObject({
      topUpStatus: 'PAID',
      providerReference: 'be116-recovered-provider-reference',
    });
  });
});
