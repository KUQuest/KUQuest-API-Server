import { env } from '@/config/env';
import { db } from '@/database/client';
import {
  paymentPayoutStatusHistory,
  paymentPayouts,
  paymentProviderEventHistory,
  paymentProviderEventInbox,
  type ProviderEventProcessingStatus,
} from '@/database/schema/payment.schema';
import {
  walletLedgerAccount,
  walletLedgerPosting,
  walletLedgerTransaction,
} from '@/database/schema/wallet.schema';
import {
  assertXenditWebhookToken,
  ProviderEventError,
} from '@/modules/top-up';
import {
  createProviderEventEncryption,
  type ProviderEventEncryption,
} from '@/modules/top-up/top-up.provider-event.crypto';
import {
  MoneyDomainError,
  positiveSatang,
  satang,
  signedSatang,
  type Satang,
} from '@/modules/wallet/wallet.money';
import {
  createSealedLedgerTransactionInTransaction,
  ensureWalletInTransaction,
  type WalletTransaction,
} from '@/modules/wallet/wallet.service';

import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from 'drizzle-orm';

import { XenditPayoutProvider } from './payout.provider';
import type {
  OutboundPayoutReconciliationProvider,
  OutboundPayoutStatusResponse,
} from './payout.provider';
import { getPayout } from './payout.service';
import {
  isPayoutProviderReversal,
  parsePayoutProviderEvent,
  type ParsedPayoutProviderEvent,
  type PayoutOutcomeStatus,
} from './payout.provider-event';

export const payoutProviderEventMaxAttempts = 5;
export const payoutProviderEventLeaseMs = 5 * 60 * 1000;

export type PayoutProviderEvent = {
  id: string;
  provider: string;
  providerEventId: string;
  eventType: string;
  resourceType: string;
  internalReference: string | null;
  providerReference: string | null;
  providerApiVersion: string | null;
  providerStatus: string;
  normalizedStatus: PayoutOutcomeStatus;
  providerAmountSatang: Satang | null;
  actualFeeSatang: Satang | null;
  actualTaxSatang: Satang | null;
  actualDebitSatang: Satang | null;
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

export type ReceivePayoutProviderEventInput = {
  rawPayload: string;
  providerEventId?: string;
  callbackToken?: string;
  webhookToken?: string;
  receivedAt?: Date;
  encryption?: ProviderEventEncryption;
};

export type PayoutProviderEventClaimInput = {
  eventId?: string;
  limit?: number;
  now?: Date;
  leaseMs?: number;
};

const providerEventSource = 'WEBHOOK';
const rawPayloadRetentionMs = 30 * 24 * 60 * 60 * 1000;

const providerEventFromRecord = (
  record: typeof paymentProviderEventInbox.$inferSelect,
): PayoutProviderEvent => ({
  id: record.id,
  provider: record.provider,
  providerEventId: record.providerEventId,
  eventType: record.eventType,
  resourceType: record.resourceType,
  internalReference: record.internalReference,
  providerReference: record.providerReference,
  providerApiVersion: record.providerApiVersion,
  providerStatus: record.providerStatus,
  normalizedStatus: record.normalizedStatus as PayoutOutcomeStatus,
  providerAmountSatang: record.providerAmountSatang === null
    ? null
    : positiveSatang(record.providerAmountSatang),
  actualFeeSatang: record.providerActualFeeSatang === null
    ? null
    : satang(record.providerActualFeeSatang),
  actualTaxSatang: record.providerActualTaxSatang === null
    ? null
    : satang(record.providerActualTaxSatang),
  actualDebitSatang: record.providerActualDebitSatang === null
    ? null
    : positiveSatang(record.providerActualDebitSatang),
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
  if (Number.isNaN(value.getTime())) {
    throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider event date is invalid.');
  }
  return value;
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

export const receivePayoutProviderEvent = async (
  input: ReceivePayoutProviderEventInput,
): Promise<PayoutProviderEvent> => {
  assertXenditWebhookToken(input.callbackToken, input.webhookToken ?? env.xenditWebhookToken);
  const receivedAt = assertDate(input.receivedAt ?? new Date());
  const parsed = parsePayoutProviderEvent(input.rawPayload, receivedAt, input.providerEventId);
  const rawPayloadExpiresAt = new Date(receivedAt.getTime() + rawPayloadRetentionMs);

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
      if (existing.resourceType !== 'PAYOUT') {
        throw new ProviderEventError(
          'PROVIDER_EVENT_CONFLICT',
          'The Provider event identifier belongs to a different payment resource.',
        );
      }
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
        providerActualFeeSatang: parsed.actualFeeSatang,
        providerActualTaxSatang: parsed.actualTaxSatang,
        providerActualDebitSatang: parsed.actualDebitSatang,
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
    if (raced.resourceType !== 'PAYOUT') {
      throw new ProviderEventError(
        'PROVIDER_EVENT_CONFLICT',
        'The Provider event identifier belongs to a different payment resource.',
      );
    }
    if (raced.payloadHash !== parsed.payloadHash) {
      throw new ProviderEventError(
        'PROVIDER_EVENT_CONFLICT',
        'The Provider event identifier was reused with a different payload.',
      );
    }
    return providerEventFromRecord(raced);
  });
};

const validateClaimInput = (input: PayoutProviderEventClaimInput) => {
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new MoneyDomainError('INVALID_LIMIT', 'Provider event limit must be between 1 and 100.');
  }
  const leaseMs = input.leaseMs ?? payoutProviderEventLeaseMs;
  if (!Number.isInteger(leaseMs) || leaseMs < 1) {
    throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider event lease must be positive.');
  }
  return { limit, leaseMs, now: assertDate(input.now ?? new Date()) };
};

const claimEvents = async (
  transaction: WalletTransaction,
  input: PayoutProviderEventClaimInput,
): Promise<PayoutProviderEvent[]> => {
  const { limit, leaseMs, now } = validateClaimInput(input);
  const staleBefore = new Date(now.getTime() - leaseMs);
  const ready = or(
    and(
      eq(paymentProviderEventInbox.resourceType, 'PAYOUT'),
      inArray(paymentProviderEventInbox.processingStatus, ['RECEIVED', 'RETRYABLE']),
      lt(paymentProviderEventInbox.attemptCount, payoutProviderEventMaxAttempts),
    ),
    and(
      eq(paymentProviderEventInbox.resourceType, 'PAYOUT'),
      eq(paymentProviderEventInbox.processingStatus, 'PROCESSING'),
      or(isNull(paymentProviderEventInbox.claimedAt), lt(paymentProviderEventInbox.claimedAt, staleBefore)),
    ),
  );
  const conditions = input.eventId
    ? and(eq(paymentProviderEventInbox.id, input.eventId), ready)
    : ready;
  const candidates = await transaction
    .select()
    .from(paymentProviderEventInbox)
    .where(conditions)
    .orderBy(asc(paymentProviderEventInbox.receivedAt), asc(paymentProviderEventInbox.id))
    .limit(input.eventId ? 1 : limit)
    .for('update', { skipLocked: true });
  const claimed: PayoutProviderEvent[] = [];
  for (const candidate of candidates) {
    if (candidate.processingStatus === 'PROCESSING' && candidate.attemptCount >= payoutProviderEventMaxAttempts) {
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

export const claimPayoutProviderEvents = async (
  input: PayoutProviderEventClaimInput = {},
): Promise<PayoutProviderEvent[]> => db.transaction((transaction) => claimEvents(transaction, input));

const payoutForEvent = async (
  transaction: WalletTransaction,
  event: Pick<ParsedPayoutProviderEvent, 'internalReference' | 'providerReference'>,
) => {
  const conditions = [
    event.internalReference ? eq(paymentPayouts.internalReference, event.internalReference) : undefined,
    event.providerReference ? eq(paymentPayouts.providerReference, event.providerReference) : undefined,
  ].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));
  if (conditions.length === 0) {
    throw new ProviderEventError('PROVIDER_EVENT_NOT_FOUND', 'Provider event has no Payout reference.');
  }
  const records = await transaction
    .select()
    .from(paymentPayouts)
    .where(or(...conditions))
    .for('update');
  if (records.length !== 1) {
    throw new ProviderEventError('PROVIDER_EVENT_NOT_FOUND', 'Provider event does not match one Payout.');
  }
  const [payout] = records;
  if (!payout) throw new ProviderEventError('PROVIDER_EVENT_NOT_FOUND', 'Provider event does not match one Payout.');
  if (event.internalReference && event.internalReference !== payout.internalReference) {
    throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider event references a different Payout.');
  }
  if (event.providerReference && payout.providerReference && event.providerReference !== payout.providerReference) {
    throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider event references a different Provider payout.');
  }
  return payout;
};

const payoutAccounts = async (transaction: WalletTransaction, walletId: string) => {
  const accounts = await transaction
    .select({ id: walletLedgerAccount.id, type: walletLedgerAccount.type })
    .from(walletLedgerAccount)
    .where(or(
      and(
        eq(walletLedgerAccount.walletId, walletId),
        inArray(walletLedgerAccount.type, ['EARNINGS', 'RESERVED_FOR_PAYOUTS']),
      ),
      eq(walletLedgerAccount.code, 'platform:PLATFORM_REVENUE'),
      eq(walletLedgerAccount.code, 'platform:PLATFORM_SUSPENSE'),
    ))
    .for('update');
  const earnings = accounts.find(({ type }) => type === 'EARNINGS');
  const payoutReserve = accounts.find(({ type }) => type === 'RESERVED_FOR_PAYOUTS');
  const platformRevenue = accounts.find(({ type }) => type === 'PLATFORM_REVENUE');
  const platformSuspense = accounts.find(({ type }) => type === 'PLATFORM_SUSPENSE');
  if (!earnings || !payoutReserve || !platformRevenue || !platformSuspense) {
    throw new MoneyDomainError('WALLET_ACCOUNT_NOT_FOUND', 'Payout Wallet accounts do not exist.');
  }
  return {
    earningsId: earnings.id,
    payoutReserveId: payoutReserve.id,
    platformRevenueId: platformRevenue.id,
    platformSuspenseId: platformSuspense.id,
  };
};

const providerFactsFor = (payout: typeof paymentPayouts.$inferSelect, facts: PayoutOutcomeFacts) => ({
  providerReference: facts.providerReference ?? payout.providerReference,
  providerApiVersion: facts.providerApiVersion ?? payout.providerApiVersion,
  providerStatus: facts.providerStatus,
  providerAmountSatang: facts.providerAmountSatang ?? payout.providerAmountSatang,
  updatedAt: new Date(),
});

type PayoutOutcomeFacts = Pick<ParsedPayoutProviderEvent, 'eventType' | 'internalReference' | 'providerReference' | 'providerApiVersion' | 'providerStatus' | 'normalizedStatus' | 'providerAmountSatang' | 'actualFeeSatang' | 'actualTaxSatang' | 'actualDebitSatang' | 'providerChannelCode' | 'providerOccurredAt'>;

const settlePayout = async (
  transaction: WalletTransaction,
  payout: typeof paymentPayouts.$inferSelect,
  actualFeeSatang: Satang,
  actualTaxSatang: Satang,
  actualDebitSatang: Satang,
) => {
  const wallet = await ensureWalletInTransaction(transaction, payout.userId);
  const accounts = await payoutAccounts(transaction, wallet.id);
  const unusedReserveSatang = payout.maximumDebitSatang - actualDebitSatang;
  const postings = [
    { accountId: accounts.payoutReserveId, amountSatang: signedSatang(-payout.maximumDebitSatang) },
    { accountId: accounts.platformSuspenseId, amountSatang: signedSatang(payout.principalSatang + actualTaxSatang) },
    ...(unusedReserveSatang > 0
      ? [{ accountId: accounts.earningsId, amountSatang: signedSatang(unusedReserveSatang) }]
      : []),
    ...(actualFeeSatang > 0
      ? [{ accountId: accounts.platformRevenueId, amountSatang: signedSatang(actualFeeSatang) }]
      : []),
  ];
  return createSealedLedgerTransactionInTransaction(transaction, {
    businessReference: `payout-settle:${payout.id}`,
    eventType: 'PAYOUT',
    createdByUserId: payout.userId,
    description: 'Settle confirmed Payout and release unused reserve',
    postings,
  });
};

const releasePayoutReserve = async (
  transaction: WalletTransaction,
  payout: typeof paymentPayouts.$inferSelect,
  businessReference: string,
  description: string,
) => {
  const wallet = await ensureWalletInTransaction(transaction, payout.userId);
  const accounts = await payoutAccounts(transaction, wallet.id);
  return createSealedLedgerTransactionInTransaction(transaction, {
    businessReference,
    eventType: 'PAYOUT',
    createdByUserId: payout.userId,
    description,
    postings: [
      { accountId: accounts.earningsId, amountSatang: signedSatang(payout.maximumDebitSatang) },
      { accountId: accounts.payoutReserveId, amountSatang: signedSatang(-payout.maximumDebitSatang) },
    ],
  });
};

const reverseCompletedPayout = async (
  transaction: WalletTransaction,
  payout: typeof paymentPayouts.$inferSelect,
) => {
  if (!payout.finalLedgerTransactionId) {
    throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Completed Payout has no ledger transaction to reverse.');
  }
  const [existingCorrection] = await transaction
    .select({ id: walletLedgerTransaction.id })
    .from(walletLedgerTransaction)
    .where(eq(walletLedgerTransaction.correctionOfTransactionId, payout.finalLedgerTransactionId))
    .limit(1);
  if (existingCorrection) return;

  const originalPostings = await transaction
    .select({ accountId: walletLedgerPosting.accountId, amountSatang: walletLedgerPosting.amountSatang })
    .from(walletLedgerPosting)
    .where(eq(walletLedgerPosting.transactionId, payout.finalLedgerTransactionId));
  if (originalPostings.length === 0) {
    throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Completed Payout ledger postings are missing.');
  }
  await createSealedLedgerTransactionInTransaction(transaction, {
    businessReference: `payout-reversal:${payout.id}`,
    eventType: 'ADJUSTMENT',
    correctionOfTransactionId: payout.finalLedgerTransactionId,
    createdByUserId: payout.userId,
    description: 'Reverse Provider-reversed Payout settlement',
    postings: originalPostings.map(({ accountId, amountSatang }) => ({
      accountId,
      amountSatang: signedSatang(-amountSatang),
    })),
  });
  await releasePayoutReserve(
    transaction,
    payout,
    `payout-reversal-release:${payout.id}`,
    'Release Provider-reversed Payout reserve',
  );
};

const applyPayoutOutcomeInTransaction = async (
  transaction: WalletTransaction,
  facts: PayoutOutcomeFacts,
  source: string,
) => {
  const payout = await payoutForEvent(transaction, facts);
  if (facts.providerAmountSatang !== null && facts.providerAmountSatang !== payout.principalSatang) {
    throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider amount does not match the Payout principal.');
  }

  const providerFacts = providerFactsFor(payout, facts);
  if (facts.normalizedStatus === 'COMPLETED') {
    const actualFeeSatang = facts.actualFeeSatang ?? (payout.actualFeeSatang === null ? satang(0) : satang(payout.actualFeeSatang));
    const actualTaxSatang = facts.actualTaxSatang ?? (payout.actualTaxSatang === null ? satang(0) : satang(payout.actualTaxSatang));
    const actualDebitSatang = facts.actualDebitSatang ?? (payout.actualDebitSatang === null
      ? positiveSatang(payout.principalSatang + actualFeeSatang + actualTaxSatang)
      : positiveSatang(payout.actualDebitSatang));
    if (
      actualDebitSatang !== payout.principalSatang + actualFeeSatang + actualTaxSatang ||
      actualDebitSatang > payout.maximumDebitSatang
    ) {
      throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider Payout amounts do not match the reserve.');
    }
    if (payout.payoutStatus === 'COMPLETED') {
      await transaction
        .update(paymentPayouts)
        .set({
          ...providerFacts,
          actualFeeSatang,
          actualTaxSatang,
          actualDebitSatang,
        })
        .where(eq(paymentPayouts.id, payout.id));
      return;
    }
    if (['FAILED', 'CANCELLED'].includes(payout.payoutStatus)) return;
    const ledger = await settlePayout(transaction, payout, actualFeeSatang, actualTaxSatang, actualDebitSatang);
    if (!ledger) throw new MoneyDomainError('PAYOUT_UPDATE_FAILED', 'Payout settlement ledger could not be created.');
    const [updated] = await transaction
      .update(paymentPayouts)
      .set({
        ...providerFacts,
        actualFeeSatang,
        actualTaxSatang,
        actualDebitSatang,
        payoutStatus: 'COMPLETED',
        finalLedgerTransactionId: ledger.id,
      })
      .where(eq(paymentPayouts.id, payout.id))
      .returning();
    if (!updated) throw new MoneyDomainError('PAYOUT_UPDATE_FAILED', 'Completed Payout state could not be saved.');
    await transaction.insert(paymentPayoutStatusHistory).values({
      payoutId: payout.id,
      fromStatus: payout.payoutStatus,
      toStatus: 'COMPLETED',
      providerStatus: facts.providerStatus,
      source,
      reason: 'Provider confirmed the Payout.',
      occurredAt: facts.providerOccurredAt,
    });
    return;
  }

  if (payout.payoutStatus === 'COMPLETED') {
    if (isPayoutProviderReversal(facts.providerStatus, facts.eventType)) {
      await reverseCompletedPayout(transaction, payout);
      await transaction.insert(paymentPayoutStatusHistory).values({
        payoutId: payout.id,
        fromStatus: 'COMPLETED',
        toStatus: 'COMPLETED',
        providerStatus: facts.providerStatus,
        source,
        reason: 'Provider reversed the completed Payout; linked ledger corrections were recorded.',
        occurredAt: facts.providerOccurredAt,
      });
      await transaction.update(paymentPayouts).set(providerFacts).where(eq(paymentPayouts.id, payout.id));
    }
    return;
  }
  if (['FAILED', 'CANCELLED'].includes(payout.payoutStatus)) return;

  const nextStatus = facts.normalizedStatus === 'CANCELLED' ? 'CANCELLED' : 'FAILED';
  if (facts.normalizedStatus === 'PENDING') {
    if (payout.payoutStatus === 'CREATING' || payout.payoutStatus === 'AWAITING_RECONCILIATION') {
      await transaction.update(paymentPayouts).set({ ...providerFacts, payoutStatus: 'PENDING' }).where(eq(paymentPayouts.id, payout.id));
      await transaction.insert(paymentPayoutStatusHistory).values({
        payoutId: payout.id,
        fromStatus: payout.payoutStatus,
        toStatus: 'PENDING',
        providerStatus: facts.providerStatus,
        source,
        reason: 'Provider reports the Payout is still in progress.',
        occurredAt: facts.providerOccurredAt,
      });
    } else {
      await transaction.update(paymentPayouts).set(providerFacts).where(eq(paymentPayouts.id, payout.id));
    }
    return;
  }

  const ledger = await releasePayoutReserve(
    transaction,
    payout,
    `payout-release:${payout.id}`,
    `Release ${nextStatus} Payout reserve`,
  );
  if (!ledger) throw new MoneyDomainError('PAYOUT_UPDATE_FAILED', 'Payout reserve could not be released.');
  const [updated] = await transaction
    .update(paymentPayouts)
    .set({
      ...providerFacts,
      payoutStatus: nextStatus,
      finalLedgerTransactionId: ledger.id,
    })
    .where(eq(paymentPayouts.id, payout.id))
    .returning();
  if (!updated) throw new MoneyDomainError('PAYOUT_UPDATE_FAILED', 'Failed Payout state could not be saved.');
  await transaction.insert(paymentPayoutStatusHistory).values({
    payoutId: payout.id,
    fromStatus: payout.payoutStatus,
    toStatus: nextStatus,
    providerStatus: facts.providerStatus,
    source,
    reason: `Provider ${nextStatus.toLowerCase()} the Payout.`,
    occurredAt: facts.providerOccurredAt,
  });
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

  await applyPayoutOutcomeInTransaction(transaction, {
    eventType: event.eventType,
    internalReference: event.internalReference,
    providerReference: event.providerReference,
    providerApiVersion: event.providerApiVersion,
    providerStatus: event.providerStatus,
    normalizedStatus: event.normalizedStatus as PayoutOutcomeStatus,
    providerAmountSatang: event.providerAmountSatang === null ? null : positiveSatang(event.providerAmountSatang),
    actualFeeSatang: event.providerActualFeeSatang === null ? null : satang(event.providerActualFeeSatang),
    actualTaxSatang: event.providerActualTaxSatang === null ? null : satang(event.providerActualTaxSatang),
    actualDebitSatang: event.providerActualDebitSatang === null ? null : positiveSatang(event.providerActualDebitSatang),
    providerChannelCode: event.providerChannelCode,
    providerOccurredAt: event.providerOccurredAt,
  }, providerEventSource);
  const [processed] = await transaction
    .update(paymentProviderEventInbox)
    .set({ processingStatus: 'PROCESSED', processedAt: new Date(), claimedAt: null, lastError: null })
    .where(eq(paymentProviderEventInbox.id, event.id))
    .returning();
  if (!processed) throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider event could not be completed.');
  await insertEventHistory(transaction, event.id, 'PROCESSING', 'PROCESSED', 'WORKER', 'Provider event applied to the Payout.');
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
  const dead = !failure.retryable || current.attemptCount >= payoutProviderEventMaxAttempts;
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

export const processPayoutProviderEvent = async (
  eventId: string,
  now = new Date(),
): Promise<PayoutProviderEvent> => {
  const [claimed] = await db.transaction((transaction) => claimEvents(transaction, { eventId, now }));
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

export const processPayoutProviderEvents = async (
  input: PayoutProviderEventClaimInput = {},
): Promise<number> => {
  const claimed = await claimPayoutProviderEvents(input);
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

export const retryPayoutProviderEvent = async (eventId: string): Promise<PayoutProviderEvent> => db.transaction(async (transaction) => {
  const [event] = await transaction
    .select()
    .from(paymentProviderEventInbox)
    .where(and(eq(paymentProviderEventInbox.id, eventId), eq(paymentProviderEventInbox.resourceType, 'PAYOUT')))
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

export const reconcilePayout = async (
  principalUserId: string,
  payoutId: string,
  provider: OutboundPayoutReconciliationProvider = new XenditPayoutProvider(),
) => {
  const payout = await getPayout(principalUserId, payoutId);
  const outcome: OutboundPayoutStatusResponse = await provider.getPayoutStatus({
    providerReference: payout.providerReference,
    internalReference: payout.internalReference,
    expectedPrincipalSatang: payout.principalSatang,
    maximumDebitSatang: payout.maximumDebitSatang,
  });
  if (payout.providerReference && outcome.providerReference !== payout.providerReference) {
    throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider reconciliation returned a different Payout reference.');
  }
  await db.transaction((transaction) => applyPayoutOutcomeInTransaction(transaction, {
    eventType: isPayoutProviderReversal(outcome.providerStatus)
      ? 'reconciliation.reversed'
      : `reconciliation.${outcome.normalizedStatus.toLowerCase()}`,
    internalReference: payout.internalReference,
    providerReference: outcome.providerReference,
    providerApiVersion: outcome.providerApiVersion,
    providerStatus: outcome.providerStatus,
    normalizedStatus: outcome.normalizedStatus,
    providerAmountSatang: outcome.providerAmountSatang,
    actualFeeSatang: outcome.actualFeeSatang,
    actualTaxSatang: outcome.actualTaxSatang,
    actualDebitSatang: outcome.actualDebitSatang,
    providerChannelCode: null,
    providerOccurredAt: outcome.occurredAt,
  }, 'RECONCILIATION'));
  return getPayout(principalUserId, payoutId);
};

export const listPayoutProviderEvents = async (limit = 50): Promise<PayoutProviderEvent[]> => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new MoneyDomainError('INVALID_LIMIT', 'Provider event limit must be between 1 and 100.');
  }
  const records = await db
    .select()
    .from(paymentProviderEventInbox)
    .where(eq(paymentProviderEventInbox.resourceType, 'PAYOUT'))
    .orderBy(desc(paymentProviderEventInbox.receivedAt), desc(paymentProviderEventInbox.id))
    .limit(limit);
  return records.map(providerEventFromRecord);
};

export const listPayoutProviderEventHistory = async (eventId: string) => {
  const [event] = await db
    .select({ id: paymentProviderEventInbox.id })
    .from(paymentProviderEventInbox)
    .where(and(eq(paymentProviderEventInbox.id, eventId), eq(paymentProviderEventInbox.resourceType, 'PAYOUT')));
  if (!event) throw new ProviderEventError('PROVIDER_EVENT_NOT_FOUND', 'Provider event does not exist.');
  return db
    .select()
    .from(paymentProviderEventHistory)
    .where(eq(paymentProviderEventHistory.eventId, eventId))
    .orderBy(asc(paymentProviderEventHistory.occurredAt), asc(paymentProviderEventHistory.id));
};

export { ProviderEventError } from '@/modules/top-up/top-up.provider-event';
