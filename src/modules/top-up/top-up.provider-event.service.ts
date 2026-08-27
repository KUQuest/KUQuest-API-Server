import { env } from '@/config/env';
import { db } from '@/database/client';
import {
  paymentProviderEventHistory,
  paymentProviderEventInbox,
  paymentTopUp,
  paymentTopUpStatusHistory,
  type ProviderEventProcessingStatus,
} from '@/database/schema/payment.schema';
import {
  walletLedgerAccount,
  walletLedgerTransaction,
} from '@/database/schema/wallet.schema';
import {
  createSealedLedgerTransactionInTransaction,
  ensureWalletInTransaction,
  type WalletTransaction,
} from '@/modules/wallet/wallet.service';
import {
  MoneyDomainError,
  positiveSatang,
  signedSatang,
  type Satang,
} from '@/modules/wallet/wallet.money';

import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lte,
  lt,
  or,
  sql,
} from 'drizzle-orm';

import { XenditPromptPayProvider } from './top-up.provider';
import type {
  InboundPaymentReconciliationProvider,
  InboundPaymentStatusResponse,
} from './top-up.provider';
import { getTopUp } from './top-up.service';
import {
  ProviderEventError,
  isTopUpProviderReversal,
  parseTopUpProviderEvent,
  type ParsedTopUpProviderEvent,
  type TopUpOutcomeStatus,
} from './top-up.provider-event';
import {
  createProviderEventEncryption,
  type ProviderEventEncryption,
} from './top-up.provider-event.crypto';

export const providerEventMaxAttempts = 5;
export const providerEventLeaseMs = 5 * 60 * 1000;
export const providerEventRawPayloadRetentionMs = 30 * 24 * 60 * 60 * 1000;

export type TopUpProviderEvent = {
  id: string;
  provider: string;
  providerEventId: string;
  eventType: string;
  resourceType: string;
  internalReference: string | null;
  providerReference: string | null;
  providerApiVersion: string | null;
  providerStatus: string;
  normalizedStatus: TopUpOutcomeStatus;
  providerAmountSatang: Satang | null;
  providerChannelCode: string | null;
  providerOccurredAt: Date;
  payloadHash: string;
  rawPayloadAvailable: boolean;
  rawPayloadExpiresAt: Date;
  processingStatus: ProviderEventProcessingStatus;
  attemptCount: number;
  claimedAt: Date | null;
  processedAt: Date | null;
  lastError: string | null;
  receivedAt: Date;
  createdAt: Date;
};

export type ReceiveTopUpProviderEventInput = {
  rawPayload: string;
  providerEventId?: string;
  callbackToken?: string;
  webhookToken?: string;
  receivedAt?: Date;
  encryption?: ProviderEventEncryption;
};

export type ProviderEventClaimInput = {
  eventId?: string;
  limit?: number;
  now?: Date;
  leaseMs?: number;
};

const providerEventSource = 'WEBHOOK';

const providerEventFromRecord = (
  record: typeof paymentProviderEventInbox.$inferSelect,
): TopUpProviderEvent => ({
  id: record.id,
  provider: record.provider,
  providerEventId: record.providerEventId,
  eventType: record.eventType,
  resourceType: record.resourceType,
  internalReference: record.internalReference,
  providerReference: record.providerReference,
  providerApiVersion: record.providerApiVersion,
  providerStatus: record.providerStatus,
  normalizedStatus: record.normalizedStatus as TopUpOutcomeStatus,
  providerAmountSatang: record.providerAmountSatang === null
    ? null
    : positiveSatang(record.providerAmountSatang),
  providerChannelCode: record.providerChannelCode,
  providerOccurredAt: record.providerOccurredAt,
  payloadHash: record.payloadHash,
  rawPayloadAvailable: record.rawPayloadCiphertext !== null,
  rawPayloadExpiresAt: record.rawPayloadExpiresAt,
  processingStatus: record.processingStatus,
  attemptCount: record.attemptCount,
  claimedAt: record.claimedAt,
  processedAt: record.processedAt,
  lastError: record.lastError,
  receivedAt: record.receivedAt,
  createdAt: record.createdAt,
});

const assertDate = (value: Date): Date => {
  if (Number.isNaN(value.getTime())) throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider event date is invalid.');
  return value;
};

export const assertXenditWebhookToken = (
  callbackToken: string | undefined,
  expectedToken = env.xenditWebhookToken,
): void => {
  if (!callbackToken || !expectedToken) {
    throw new ProviderEventError(
      'PROVIDER_EVENT_AUTHENTICATION_FAILED',
      'The Xendit webhook token is invalid.',
    );
  }
  const provided = Buffer.from(callbackToken, 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new ProviderEventError(
      'PROVIDER_EVENT_AUTHENTICATION_FAILED',
      'The Xendit webhook token is invalid.',
    );
  }
};

const insertEventHistory = async (
  transaction: WalletTransaction,
  eventId: string,
  fromStatus: ProviderEventProcessingStatus | null,
  toStatus: ProviderEventProcessingStatus,
  source: string,
  reason?: string,
  error?: string,
) => {
  await transaction.insert(paymentProviderEventHistory).values({
    eventId,
    fromStatus: fromStatus ?? undefined,
    toStatus,
    source,
    reason,
    error,
  });
};

export const receiveTopUpProviderEvent = async (
  input: ReceiveTopUpProviderEventInput,
): Promise<TopUpProviderEvent> => {
  assertXenditWebhookToken(input.callbackToken, input.webhookToken ?? env.xenditWebhookToken);
  const receivedAt = assertDate(input.receivedAt ?? new Date());
  const parsed = parseTopUpProviderEvent(input.rawPayload, receivedAt, input.providerEventId);
  const rawPayloadExpiresAt = new Date(receivedAt.getTime() + providerEventRawPayloadRetentionMs);

  return db.transaction(async (transaction) => {
    const [existing] = await transaction
      .select()
      .from(paymentProviderEventInbox)
      .where(and(
        eq(paymentProviderEventInbox.provider, parsed.provider),
        eq(paymentProviderEventInbox.providerEventId, parsed.providerEventId),
      ))
      .for('update');
    if (existing) {
      if (existing.payloadHash !== parsed.payloadHash) {
        throw new ProviderEventError(
          'PROVIDER_EVENT_CONFLICT',
          'The Provider event identifier was reused with a different payload.',
        );
      }
      return providerEventFromRecord(existing);
    }

    const encrypted = (input.encryption ?? createProviderEventEncryption()).encrypt(input.rawPayload);
    const [created] = await transaction
      .insert(paymentProviderEventInbox)
      .values({
        provider: parsed.provider,
        providerEventId: parsed.providerEventId,
        eventType: parsed.eventType,
        resourceType: parsed.resourceType,
        internalReference: parsed.internalReference,
        providerReference: parsed.providerReference,
        providerApiVersion: parsed.providerApiVersion,
        providerStatus: parsed.providerStatus,
        normalizedStatus: parsed.normalizedStatus,
        providerAmountSatang: parsed.providerAmountSatang,
        providerChannelCode: parsed.providerChannelCode,
        providerOccurredAt: parsed.providerOccurredAt,
        payloadHash: parsed.payloadHash,
        rawPayloadKeyVersion: encrypted.keyVersion,
        rawPayloadNonce: encrypted.nonce,
        rawPayloadCiphertext: encrypted.ciphertext,
        rawPayloadAuthTag: encrypted.authTag,
        rawPayloadExpiresAt,
        receivedAt,
        createdAt: receivedAt,
      })
      .onConflictDoNothing({
        target: [paymentProviderEventInbox.provider, paymentProviderEventInbox.providerEventId],
      })
      .returning();
    if (created) {
      await insertEventHistory(transaction, created.id, null, 'RECEIVED', providerEventSource);
      return providerEventFromRecord(created);
    }

    const [raced] = await transaction
      .select()
      .from(paymentProviderEventInbox)
      .where(and(
        eq(paymentProviderEventInbox.provider, parsed.provider),
        eq(paymentProviderEventInbox.providerEventId, parsed.providerEventId),
      ))
      .for('update');
    if (!raced) throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider event could not be stored.');
    if (raced.payloadHash !== parsed.payloadHash) {
      throw new ProviderEventError(
        'PROVIDER_EVENT_CONFLICT',
        'The Provider event identifier was reused with a different payload.',
      );
    }
    return providerEventFromRecord(raced);
  });
};

const validateClaimInput = (input: ProviderEventClaimInput) => {
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new MoneyDomainError('INVALID_LIMIT', 'Provider event limit must be between 1 and 100.');
  }
  const leaseMs = input.leaseMs ?? providerEventLeaseMs;
  if (!Number.isInteger(leaseMs) || leaseMs < 1) {
    throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider event lease must be positive.');
  }
  return { limit, leaseMs, now: assertDate(input.now ?? new Date()) };
};

const claimEvents = async (
  transaction: WalletTransaction,
  input: ProviderEventClaimInput,
  eventId?: string,
): Promise<TopUpProviderEvent[]> => {
  const { limit, leaseMs, now } = validateClaimInput(input);
  const staleBefore = new Date(now.getTime() - leaseMs);
  const ready = or(
    and(
      inArray(paymentProviderEventInbox.processingStatus, ['RECEIVED', 'RETRYABLE']),
      lt(paymentProviderEventInbox.attemptCount, providerEventMaxAttempts),
    ),
    and(
      eq(paymentProviderEventInbox.processingStatus, 'PROCESSING'),
      or(isNull(paymentProviderEventInbox.claimedAt), lt(paymentProviderEventInbox.claimedAt, staleBefore)),
    ),
  );
  const conditions = eventId
    ? and(eq(paymentProviderEventInbox.id, eventId), ready)
    : ready;
  const candidates = await transaction
    .select()
    .from(paymentProviderEventInbox)
    .where(conditions)
    .orderBy(asc(paymentProviderEventInbox.receivedAt), asc(paymentProviderEventInbox.id))
    .limit(eventId ? 1 : limit)
    .for('update', { skipLocked: true });
  const claimed: TopUpProviderEvent[] = [];
  for (const candidate of candidates) {
    if (candidate.processingStatus === 'PROCESSING' && candidate.attemptCount >= providerEventMaxAttempts) {
      // Keep claim updates and their history rows ordered in one transaction.
      // eslint-disable-next-line no-await-in-loop
      const [dead] = await transaction
        .update(paymentProviderEventInbox)
        .set({
          processingStatus: 'DEAD_LETTER',
          claimedAt: null,
          lastError: 'PROVIDER_EVENT_MAX_ATTEMPTS',
        })
        .where(eq(paymentProviderEventInbox.id, candidate.id))
        .returning();
      if (dead) {
        // eslint-disable-next-line no-await-in-loop
        await insertEventHistory(transaction, dead.id, 'PROCESSING', 'DEAD_LETTER', 'WORKER', 'Maximum Provider event attempts reached.', 'PROVIDER_EVENT_MAX_ATTEMPTS');
      }
      continue;
    }
    // Keep claim updates and their history rows ordered in one transaction.
    // eslint-disable-next-line no-await-in-loop
    const [updated] = await transaction
      .update(paymentProviderEventInbox)
      .set({
        processingStatus: 'PROCESSING',
        attemptCount: sql`${paymentProviderEventInbox.attemptCount} + 1`,
        claimedAt: now,
        lastError: null,
      })
      .where(eq(paymentProviderEventInbox.id, candidate.id))
      .returning();
    if (!updated) continue;
    // eslint-disable-next-line no-await-in-loop
    await insertEventHistory(transaction, updated.id, candidate.processingStatus, 'PROCESSING', 'WORKER', 'Provider event claimed.');
    claimed.push(providerEventFromRecord(updated));
  }
  return claimed;
};

export const claimTopUpProviderEvents = async (
  input: ProviderEventClaimInput = {},
): Promise<TopUpProviderEvent[]> => db.transaction((transaction) => claimEvents(transaction, input, input.eventId));

const topUpForEvent = async (
  transaction: WalletTransaction,
  event: Pick<ParsedTopUpProviderEvent, 'internalReference' | 'providerReference'>,
) => {
  const conditions = [
    event.internalReference ? eq(paymentTopUp.internalReference, event.internalReference) : undefined,
    event.providerReference ? eq(paymentTopUp.providerReference, event.providerReference) : undefined,
  ].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));
  if (conditions.length === 0) throw new ProviderEventError('PROVIDER_EVENT_NOT_FOUND', 'Provider event has no Top-up reference.');
  const records = await transaction
    .select()
    .from(paymentTopUp)
    .where(or(...conditions))
    .for('update');
  if (records.length !== 1) throw new ProviderEventError('PROVIDER_EVENT_NOT_FOUND', 'Provider event does not match one Top-up.');
  const [topUp] = records;
  if (!topUp) throw new ProviderEventError('PROVIDER_EVENT_NOT_FOUND', 'Provider event does not match one Top-up.');
  if (event.internalReference && event.internalReference !== topUp.internalReference) {
    throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider event references a different Top-up.');
  }
  if (event.providerReference && topUp.providerReference && event.providerReference !== topUp.providerReference) {
    throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider event references a different Provider payment.');
  }
  return topUp;
};

type TopUpOutcomeFacts = Pick<ParsedTopUpProviderEvent, 'eventType' | 'internalReference' | 'providerReference' | 'providerApiVersion' | 'providerStatus' | 'normalizedStatus' | 'providerAmountSatang' | 'providerChannelCode' | 'providerOccurredAt'>;

const accountIdsForTopUp = async (transaction: WalletTransaction, walletId: string) => {
  const accounts = await transaction
    .select({ id: walletLedgerAccount.id, type: walletLedgerAccount.type })
    .from(walletLedgerAccount)
    .where(and(
      or(
        eq(walletLedgerAccount.walletId, walletId),
        eq(walletLedgerAccount.code, 'platform:PLATFORM_SUSPENSE'),
      ),
      inArray(walletLedgerAccount.type, ['SPENDING', 'PLATFORM_SUSPENSE']),
    ))
    .for('update');
  const spending = accounts.find(({ type }) => type === 'SPENDING');
  const suspense = accounts.find(({ type }) => type === 'PLATFORM_SUSPENSE');
  if (!spending || !suspense) throw new MoneyDomainError('WALLET_ACCOUNT_NOT_FOUND', 'Top-up Wallet accounts do not exist.');
  return { spendingId: spending.id, suspenseId: suspense.id };
};

const reversePaidTopUpInTransaction = async (
  transaction: WalletTransaction,
  topUp: typeof paymentTopUp.$inferSelect,
) => {
  if (!topUp.creditedLedgerTransactionId) {
    throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Paid Top-up has no ledger transaction to reverse.');
  }
  const [existingCorrection] = await transaction
    .select({ id: walletLedgerTransaction.id })
    .from(walletLedgerTransaction)
    .where(eq(walletLedgerTransaction.correctionOfTransactionId, topUp.creditedLedgerTransactionId))
    .limit(1);
  if (existingCorrection) return;

  const wallet = await ensureWalletInTransaction(transaction, topUp.userId);
  const { spendingId, suspenseId } = await accountIdsForTopUp(transaction, wallet.id);
  await createSealedLedgerTransactionInTransaction(transaction, {
    businessReference: `top-up-reversal:${topUp.id}`,
    eventType: 'ADJUSTMENT',
    correctionOfTransactionId: topUp.creditedLedgerTransactionId,
    createdByUserId: topUp.userId,
    description: 'Reverse a Provider-reversed Top-up credit',
    postings: [
      { accountId: spendingId, amountSatang: signedSatang(-topUp.creditSatang) },
      { accountId: suspenseId, amountSatang: signedSatang(topUp.creditSatang) },
    ],
  });
};

const applyTopUpOutcomeInTransaction = async (
  transaction: WalletTransaction,
  facts: TopUpOutcomeFacts,
  source: string,
) => {
  const topUp = await topUpForEvent(transaction, facts);
  if (facts.normalizedStatus === 'PAID' && facts.providerAmountSatang === null) {
    throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'A confirmed Provider event must include an amount.');
  }
  if (facts.providerAmountSatang !== null && facts.providerAmountSatang !== topUp.paymentTotalSatang) {
    throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider amount does not match the Top-up total.');
  }

  const providerReference = facts.providerReference ?? topUp.providerReference;
  if (providerReference && topUp.providerReference && providerReference !== topUp.providerReference) {
    throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider payment reference does not match the Top-up.');
  }

  const baseUpdate = {
    providerReference,
    providerApiVersion: facts.providerApiVersion ?? topUp.providerApiVersion,
    providerStatus: facts.providerStatus,
    providerAmountSatang: facts.providerAmountSatang ?? topUp.providerAmountSatang,
    providerChannelCode: facts.providerChannelCode ?? topUp.providerChannelCode,
    updatedAt: new Date(),
  };
  if (topUp.topUpStatus !== 'PENDING') {
    if (topUp.topUpStatus === 'PAID' && isTopUpProviderReversal(facts.providerStatus, facts.eventType)) {
      await reversePaidTopUpInTransaction(transaction, topUp);
    }
    return topUp;
  }

  if (facts.normalizedStatus === 'PENDING') {
    const [updated] = await transaction
      .update(paymentTopUp)
      .set(baseUpdate)
      .where(eq(paymentTopUp.id, topUp.id))
      .returning();
    return updated ?? topUp;
  }

  let finalLedgerTransactionId: string | undefined;
  if (facts.normalizedStatus === 'PAID') {
    const wallet = await ensureWalletInTransaction(transaction, topUp.userId);
    const { spendingId, suspenseId } = await accountIdsForTopUp(transaction, wallet.id);
    const ledger = await createSealedLedgerTransactionInTransaction(transaction, {
      businessReference: `top-up-credit:${topUp.id}`,
      eventType: 'TOP_UP',
      createdByUserId: topUp.userId,
      description: 'Apply confirmed Top-up to Spending Balance',
      postings: [
        { accountId: spendingId, amountSatang: signedSatang(topUp.creditSatang) },
        { accountId: suspenseId, amountSatang: signedSatang(-topUp.creditSatang) },
      ],
    });
    finalLedgerTransactionId = ledger.id;
  }

  const [updated] = await transaction
    .update(paymentTopUp)
    .set({
      ...baseUpdate,
      topUpStatus: facts.normalizedStatus,
      creditedLedgerTransactionId: finalLedgerTransactionId ?? null,
    })
    .where(eq(paymentTopUp.id, topUp.id))
    .returning();
  if (!updated) throw new MoneyDomainError('TOP_UP_UPDATE_FAILED', 'Top-up outcome could not be saved.');
  await transaction.insert(paymentTopUpStatusHistory).values({
    topUpId: topUp.id,
    fromStatus: 'PENDING',
    toStatus: facts.normalizedStatus,
    providerStatus: facts.providerStatus,
    source,
    reason: facts.normalizedStatus === 'PAID' ? 'Provider confirmed the Top-up.' : 'Provider ended the Top-up without payment.',
    occurredAt: facts.providerOccurredAt,
  });
  return updated;
};

const completeClaimedEvent = async (eventId: string) => db.transaction(async (transaction) => {
  const [event] = await transaction
    .select()
    .from(paymentProviderEventInbox)
    .where(eq(paymentProviderEventInbox.id, eventId))
    .for('update');
  if (!event) throw new ProviderEventError('PROVIDER_EVENT_NOT_FOUND', 'Provider event does not exist.');
  if (event.processingStatus === 'PROCESSED') return providerEventFromRecord(event);
  if (event.processingStatus !== 'PROCESSING') throw new ProviderEventError('PROVIDER_EVENT_NOT_RETRYABLE', 'Provider event is not claimed.');

  await applyTopUpOutcomeInTransaction(transaction, {
    internalReference: event.internalReference,
    providerReference: event.providerReference,
    eventType: event.eventType,
    providerApiVersion: event.providerApiVersion,
    providerStatus: event.providerStatus,
    normalizedStatus: event.normalizedStatus as TopUpOutcomeStatus,
    providerAmountSatang: event.providerAmountSatang === null ? null : positiveSatang(event.providerAmountSatang),
    providerChannelCode: event.providerChannelCode,
    providerOccurredAt: event.providerOccurredAt,
  }, providerEventSource);
  const [processed] = await transaction
    .update(paymentProviderEventInbox)
    .set({ processingStatus: 'PROCESSED', processedAt: new Date(), claimedAt: null, lastError: null })
    .where(eq(paymentProviderEventInbox.id, event.id))
    .returning();
  if (!processed) throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider event could not be completed.');
  await insertEventHistory(transaction, event.id, 'PROCESSING', 'PROCESSED', 'WORKER', 'Provider event applied to the Top-up.');
  return providerEventFromRecord(processed);
});

const safeProcessingError = (error: unknown): { code: string; retryable: boolean } => {
  if (error instanceof ProviderEventError) {
    const permanent = [
      'PROVIDER_EVENT_INVALID',
      'PROVIDER_EVENT_CONFLICT',
      'PROVIDER_EVENT_AUTHENTICATION_FAILED',
      'PROVIDER_EVENT_NOT_RETRYABLE',
    ].includes(error.code);
    return { code: error.code, retryable: !permanent };
  }
  return { code: 'PROVIDER_EVENT_PROCESSING_FAILED', retryable: true };
};

const failClaimedEvent = async (eventId: string, error: unknown) => db.transaction(async (transaction) => {
  const [current] = await transaction
    .select()
    .from(paymentProviderEventInbox)
    .where(eq(paymentProviderEventInbox.id, eventId))
    .for('update');
  if (!current || current.processingStatus !== 'PROCESSING') return;
  const failure = safeProcessingError(error);
  const dead = !failure.retryable || current.attemptCount >= providerEventMaxAttempts;
  const nextStatus: ProviderEventProcessingStatus = dead ? 'DEAD_LETTER' : 'RETRYABLE';
  const [updated] = await transaction
    .update(paymentProviderEventInbox)
    .set({ processingStatus: nextStatus, claimedAt: null, lastError: failure.code })
    .where(eq(paymentProviderEventInbox.id, current.id))
    .returning();
  if (updated) {
    await insertEventHistory(transaction, current.id, 'PROCESSING', nextStatus, 'WORKER', 'Provider event processing failed.', failure.code);
  }
});

export const processTopUpProviderEvent = async (
  eventId: string,
  now = new Date(),
): Promise<TopUpProviderEvent> => {
  const [claimed] = await db.transaction((transaction) => claimEvents(transaction, { now }, eventId));
  if (!claimed) {
    const [existing] = await db.select().from(paymentProviderEventInbox).where(eq(paymentProviderEventInbox.id, eventId));
    if (!existing) throw new ProviderEventError('PROVIDER_EVENT_NOT_FOUND', 'Provider event does not exist.');
    if (existing.processingStatus === 'PROCESSED') return providerEventFromRecord(existing);
    throw new ProviderEventError('PROVIDER_EVENT_NOT_RETRYABLE', 'Provider event cannot be claimed.');
  }
  try {
    return await completeClaimedEvent(eventId);
  } catch (error) {
    await failClaimedEvent(eventId, error);
    throw error;
  }
};

export const processTopUpProviderEvents = async (
  input: ProviderEventClaimInput = {},
): Promise<number> => {
  const claimed = await claimTopUpProviderEvents(input);
  let processed = 0;
  for (const event of claimed) {
    try {
      // Process one event at a time to keep Wallet locks ordered.
      // eslint-disable-next-line no-await-in-loop
      await completeClaimedEvent(event.id);
      processed += 1;
    } catch (error) {
      // Process one event at a time to keep Wallet locks ordered.
      // eslint-disable-next-line no-await-in-loop
      await failClaimedEvent(event.id, error);
    }
  }
  return processed;
};

export const retryTopUpProviderEvent = async (eventId: string): Promise<TopUpProviderEvent> => db.transaction(async (transaction) => {
  const [event] = await transaction
    .select()
    .from(paymentProviderEventInbox)
    .where(eq(paymentProviderEventInbox.id, eventId))
    .for('update');
  if (!event) throw new ProviderEventError('PROVIDER_EVENT_NOT_FOUND', 'Provider event does not exist.');
  if (event.processingStatus !== 'RETRYABLE') throw new ProviderEventError('PROVIDER_EVENT_NOT_RETRYABLE', 'Provider event is not ready for retry.');
  const [updated] = await transaction
    .update(paymentProviderEventInbox)
    .set({ processingStatus: 'RECEIVED', claimedAt: null, lastError: null })
    .where(eq(paymentProviderEventInbox.id, event.id))
    .returning();
  if (!updated) throw new ProviderEventError('PROVIDER_EVENT_NOT_RETRYABLE', 'Provider event could not be retried.');
  await insertEventHistory(transaction, event.id, 'RETRYABLE', 'RECEIVED', 'OPERATOR', 'Provider event retry requested.');
  return providerEventFromRecord(updated);
});

export const reconcileTopUp = async (
  principalUserId: string,
  topUpId: string,
  provider: InboundPaymentReconciliationProvider = new XenditPromptPayProvider(),
) => {
  const [record] = await db
    .select()
    .from(paymentTopUp)
    .where(and(eq(paymentTopUp.id, topUpId), eq(paymentTopUp.userId, principalUserId)));
  if (!record) throw new MoneyDomainError('TOP_UP_NOT_FOUND', 'Top-up does not exist.');
  const outcome: InboundPaymentStatusResponse = await provider.getPaymentStatus({
    providerReference: record.providerReference,
    internalReference: record.internalReference,
    expectedPaymentTotalSatang: positiveSatang(record.paymentTotalSatang),
  });
  if (record.providerReference && outcome.providerReference !== record.providerReference) {
    throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider reconciliation returned a different payment reference.');
  }
  await db.transaction((transaction) => applyTopUpOutcomeInTransaction(transaction, {
    eventType: 'payment.capture',
    internalReference: record.internalReference,
    providerReference: outcome.providerReference,
    providerApiVersion: outcome.providerApiVersion,
    providerStatus: outcome.providerStatus,
    normalizedStatus: outcome.normalizedStatus,
    providerAmountSatang: outcome.providerAmountSatang,
    providerChannelCode: outcome.providerChannelCode,
    providerOccurredAt: outcome.occurredAt,
  }, 'RECONCILIATION'));
  return getTopUp(principalUserId, record.id);
};

export const purgeExpiredProviderEventPayloads = async (now = new Date()): Promise<number> => {
  assertDate(now);
  const expired = await db
    .update(paymentProviderEventInbox)
    .set({
      rawPayloadKeyVersion: null,
      rawPayloadNonce: null,
      rawPayloadCiphertext: null,
      rawPayloadAuthTag: null,
    })
    .where(and(
      lte(paymentProviderEventInbox.rawPayloadExpiresAt, now),
      sql`${paymentProviderEventInbox.rawPayloadCiphertext} IS NOT NULL`,
    ))
    .returning({ id: paymentProviderEventInbox.id });
  return expired.length;
};

export const listTopUpProviderEvents = async (limit = 50): Promise<TopUpProviderEvent[]> => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new MoneyDomainError('INVALID_LIMIT', 'Provider event limit must be between 1 and 100.');
  }
  const records = await db
    .select()
    .from(paymentProviderEventInbox)
    .orderBy(desc(paymentProviderEventInbox.receivedAt), desc(paymentProviderEventInbox.id))
    .limit(limit);
  return records.map(providerEventFromRecord);
};

export const listTopUpProviderEventHistory = async (eventId: string) => {
  const [event] = await db
    .select({ id: paymentProviderEventInbox.id })
    .from(paymentProviderEventInbox)
    .where(eq(paymentProviderEventInbox.id, eventId));
  if (!event) throw new ProviderEventError('PROVIDER_EVENT_NOT_FOUND', 'Provider event does not exist.');
  return db
    .select()
    .from(paymentProviderEventHistory)
    .where(eq(paymentProviderEventHistory.eventId, eventId))
    .orderBy(asc(paymentProviderEventHistory.occurredAt), asc(paymentProviderEventHistory.id));
};

export { ProviderEventError } from './top-up.provider-event';
