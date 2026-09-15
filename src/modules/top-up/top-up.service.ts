import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import {
  paymentTopUp,
  paymentTopUpQuote,
  paymentTopUpStatusHistory,
  type TopUpStatus,
} from '@/database/schema/payment.schema';
import { walletWallet } from '@/database/schema/wallet.schema';
import {
  assertWalletOperationAllowed,
  completeMoneyCommand,
  ensureWalletInTransaction,
  getEffectiveMoneyPolicy,
  MAX_WALLET_CAPACITY_SATANG,
  MoneyDomainError,
  positiveSatang,
  runMoneyCommand,
  satang,
  sha256Json,
  stampMoneyCommandResource,
  validateOperationAmount,
  type Satang,
} from '@/modules/wallet';
import { and, asc, desc, eq } from 'drizzle-orm';

import {
  InboundPaymentProviderError,
  type InboundPaymentProvider,
  type InboundPaymentResponse,
  XenditPromptPayProvider,
} from './top-up.provider';

export const topUpOperationScope = 'wallet.top-up';

export type TopUpQuoteInput = {
  principalUserId: string;
  creditSatang: Satang;
};

export type TopUpQuote = {
  id: string;
  principalUserId: string;
  policyRevisionId: string;
  creditSatang: Satang;
  chargedFeeSatang: Satang;
  chargedTaxSatang: Satang;
  paymentTotalSatang: Satang;
  providerFeeSatang: Satang;
  providerTaxSatang: Satang;
  providerTotalSatang: Satang;
  feeRoundingMode: 'UP';
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
};

export type InitiateTopUpInput = {
  principalUserId: string;
  quoteId: string;
  idempotency: { key: string };
};

export type TopUp = {
  id: string;
  internalReference: string;
  principalUserId: string;
  quoteId: string;
  provider: string;
  providerReference: string | null;
  providerApiVersion: string | null;
  providerStatus: string | null;
  providerAmountSatang: Satang | null;
  providerChannelCode: string | null;
  creditSatang: Satang;
  chargedFeeSatang: Satang;
  chargedTaxSatang: Satang;
  paymentTotalSatang: Satang;
  providerFeeSatang: Satang;
  providerTaxSatang: Satang;
  providerTotalSatang: Satang;
  qrPayload: string | null;
  qrExpiresAt: Date | null;
  topUpStatus: TopUpStatus;
  creditedLedgerTransactionId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const topUpBusinessReference = (topUpId: string) => `top-up:${topUpId}`;

const validateTotal = (values: number[]) => {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total) || total > MAX_WALLET_CAPACITY_SATANG) {
    throw new MoneyDomainError('SATANG_OVERFLOW', 'The Top-up amount exceeds the Wallet capacity.');
  }
  return satang(total);
};

const quoteFromRecord = (record: typeof paymentTopUpQuote.$inferSelect): TopUpQuote => ({
  id: record.id,
  principalUserId: record.userId,
  policyRevisionId: record.policyRevisionId,
  creditSatang: positiveSatang(record.creditSatang),
  chargedFeeSatang: satang(record.chargedFeeSatang),
  chargedTaxSatang: satang(record.chargedTaxSatang),
  paymentTotalSatang: positiveSatang(record.paymentTotalSatang),
  providerFeeSatang: satang(record.providerFeeSatang),
  providerTaxSatang: satang(record.providerTaxSatang),
  providerTotalSatang: positiveSatang(record.providerTotalSatang),
  feeRoundingMode: 'UP',
  expiresAt: record.expiresAt,
  consumedAt: record.consumedAt,
  createdAt: record.createdAt,
});

const topUpFromRecord = (record: typeof paymentTopUp.$inferSelect): TopUp => ({
  id: record.id,
  internalReference: record.internalReference,
  principalUserId: record.userId,
  quoteId: record.quoteId,
  provider: record.provider,
  providerReference: record.providerReference,
  providerApiVersion: record.providerApiVersion,
  providerStatus: record.providerStatus,
  providerAmountSatang:
    record.providerAmountSatang === null ? null : positiveSatang(record.providerAmountSatang),
  providerChannelCode: record.providerChannelCode,
  creditSatang: positiveSatang(record.creditSatang),
  chargedFeeSatang: satang(record.chargedFeeSatang),
  chargedTaxSatang: satang(record.chargedTaxSatang),
  paymentTotalSatang: positiveSatang(record.paymentTotalSatang),
  providerFeeSatang: satang(record.providerFeeSatang),
  providerTaxSatang: satang(record.providerTaxSatang),
  providerTotalSatang: positiveSatang(record.providerTotalSatang),
  qrPayload: record.qrPayload,
  qrExpiresAt: record.qrExpiresAt,
  topUpStatus: record.topUpStatus,
  creditedLedgerTransactionId: record.creditedLedgerTransactionId,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

const assertMemberExists = async (principalUserId: string) => {
  const [member] = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.id, principalUserId))
    .limit(1);
  if (!member) throw new MoneyDomainError('MEMBER_NOT_FOUND', 'Member does not exist.');
};

const calculateTopUpTerms = (
  creditSatang: Satang,
  policy: {
    topUpProviderFeeSatang: number;
    topUpProviderFeeBps?: number;
    topUpProviderTaxBps: number;
  }
) => {
  const fixedFeeSatang = satang(policy.topUpProviderFeeSatang);
  const variableFeeSatang = policy.topUpProviderFeeBps
    ? satang(Math.ceil((creditSatang * policy.topUpProviderFeeBps) / 10_000))
    : satang(0);
  const providerFeeSatang = satang(fixedFeeSatang + variableFeeSatang);
  const providerTaxSatang = satang(
    Math.floor((providerFeeSatang * policy.topUpProviderTaxBps) / 10_000)
  );
  const paymentTotalSatang = validateTotal([creditSatang, providerFeeSatang, providerTaxSatang]);
  return {
    chargedFeeSatang: providerFeeSatang,
    chargedTaxSatang: providerTaxSatang,
    paymentTotalSatang,
    providerFeeSatang,
    providerTaxSatang,
    providerTotalSatang: paymentTotalSatang,
  };
};

export const quoteTopUp = async (input: TopUpQuoteInput): Promise<TopUpQuote> => {
  await assertMemberExists(input.principalUserId);
  const policy = await getEffectiveMoneyPolicy();
  const creditSatang = validateOperationAmount(
    input.creditSatang,
    policy.minimumTopUpSatang,
    policy.maximumTopUpSatang
  );
  const terms = calculateTopUpTerms(creditSatang, policy);
  const expiresAt = new Date(Date.now() + policy.quoteLifetimeSeconds * 1000);
  const [created] = await db
    .insert(paymentTopUpQuote)
    .values({
      userId: input.principalUserId,
      policyRevisionId: policy.id,
      creditSatang,
      ...terms,
      feeRoundingMode: policy.feeRoundingMode as 'UP',
      expiresAt,
    })
    .returning();
  if (!created)
    throw new MoneyDomainError('TOP_UP_QUOTE_CREATE_FAILED', 'Top-up quote could not be created.');
  return quoteFromRecord(created);
};

type PreparedTopUp = {
  topUp: TopUp;
  paymentRequest: {
    internalReference: string;
    paymentTotalSatang: Satang;
    expiresAt: Date;
  };
  idempotencyKeyId: string;
};

const prepareTopUp = async (
  input: InitiateTopUpInput,
  requestHash: string
): Promise<PreparedTopUp> =>
  db.transaction(async (transaction) => {
    if (input.idempotency.key.trim().length === 0) {
      throw new MoneyDomainError('IDEMPOTENCY_UNAVAILABLE', 'Idempotency key must not be empty.');
    }
    const { result } = await runMoneyCommand(
      transaction,
      {
        principalUserId: input.principalUserId,
        scope: topUpOperationScope,
        key: input.idempotency.key,
        requestHash,
      },
      {
        execute: async (transaction, keyId) => {
          await ensureWalletInTransaction(transaction, input.principalUserId);
          const [wallet] = await transaction
            .select()
            .from(walletWallet)
            .where(eq(walletWallet.userId, input.principalUserId))
            .for('update');
          if (!wallet) throw new MoneyDomainError('WALLET_NOT_FOUND', 'Wallet does not exist.');
          assertWalletOperationAllowed(wallet.walletStatus, 'TOP_UP');

          const [quote] = await transaction
            .select()
            .from(paymentTopUpQuote)
            .where(
              and(
                eq(paymentTopUpQuote.id, input.quoteId),
                eq(paymentTopUpQuote.userId, input.principalUserId)
              )
            )
            .for('update');
          if (!quote)
            throw new MoneyDomainError('TOP_UP_QUOTE_NOT_FOUND', 'Top-up quote does not exist.');
          if (quote.consumedAt)
            throw new MoneyDomainError(
              'TOP_UP_QUOTE_CONSUMED',
              'Top-up quote was already consumed.'
            );
          if (quote.expiresAt <= new Date())
            throw new MoneyDomainError('TOP_UP_QUOTE_EXPIRED', 'Top-up quote has expired.');

          const pending = await transaction
            .select({ creditSatang: paymentTopUp.creditSatang })
            .from(paymentTopUp)
            .where(
              and(
                eq(paymentTopUp.userId, input.principalUserId),
                eq(paymentTopUp.topUpStatus, 'PENDING')
              )
            );
          const walletTotal =
            wallet.spendingBalanceSatang +
            wallet.earningsBalanceSatang +
            wallet.fundingReservedSatang +
            wallet.reservedForPayoutsSatang;
          const pendingTotal = pending.reduce((total, row) => total + row.creditSatang, 0);
          if (walletTotal + pendingTotal + quote.creditSatang > MAX_WALLET_CAPACITY_SATANG) {
            throw new MoneyDomainError(
              'WALLET_CAPACITY_EXCEEDED',
              'Pending Top-up funds would exceed Wallet capacity.'
            );
          }

          const topUpId = crypto.randomUUID();
          const internalReference = topUpBusinessReference(topUpId);
          const [created] = await transaction
            .insert(paymentTopUp)
            .values({
              internalReference,
              userId: input.principalUserId,
              quoteId: quote.id,
              provider: 'XENDIT',
              creditSatang: quote.creditSatang,
              chargedFeeSatang: quote.chargedFeeSatang,
              chargedTaxSatang: quote.chargedTaxSatang,
              paymentTotalSatang: quote.paymentTotalSatang,
              providerFeeSatang: quote.providerFeeSatang,
              providerTaxSatang: quote.providerTaxSatang,
              providerTotalSatang: quote.providerTotalSatang,
              topUpStatus: 'PENDING',
            })
            .returning();
          if (!created)
            throw new MoneyDomainError('TOP_UP_CREATE_FAILED', 'Top-up could not be created.');
          await transaction.insert(paymentTopUpStatusHistory).values({
            topUpId: created.id,
            toStatus: 'PENDING',
            source: 'INITIATION',
            actorUserId: input.principalUserId,
          });
          await transaction
            .update(paymentTopUpQuote)
            .set({ consumedAt: new Date() })
            .where(eq(paymentTopUpQuote.id, quote.id));
          await stampMoneyCommandResource(transaction, keyId, 'payment_top_up', created.id);

          return {
            topUp: topUpFromRecord(created),
            paymentRequest: {
              internalReference,
              paymentTotalSatang: positiveSatang(created.paymentTotalSatang),
              expiresAt: quote.expiresAt,
            },
            idempotencyKeyId: keyId,
          };
        },
        replay: async (transaction, keyRow) => {
          if (!keyRow.resourceId)
            throw new MoneyDomainError(
              'IDEMPOTENCY_IN_PROGRESS',
              'A Top-up with this idempotency key is still processing.'
            );
          const [replayed] = await transaction
            .select()
            .from(paymentTopUp)
            .where(
              and(
                eq(paymentTopUp.id, keyRow.resourceId),
                eq(paymentTopUp.userId, input.principalUserId)
              )
            );
          if (!replayed)
            throw new MoneyDomainError(
              'IDEMPOTENCY_UNAVAILABLE',
              'The idempotent Top-up record is missing.'
            );
          const topUp = topUpFromRecord(replayed);
          const [quote] = await transaction
            .select({ expiresAt: paymentTopUpQuote.expiresAt })
            .from(paymentTopUpQuote)
            .where(
              and(
                eq(paymentTopUpQuote.id, topUp.quoteId),
                eq(paymentTopUpQuote.userId, input.principalUserId)
              )
            );
          if (!quote)
            throw new MoneyDomainError(
              'IDEMPOTENCY_UNAVAILABLE',
              'The idempotent Top-up quote is missing.'
            );
          return {
            topUp,
            paymentRequest: {
              internalReference: topUp.internalReference,
              paymentTotalSatang: topUp.paymentTotalSatang,
              expiresAt: quote.expiresAt,
            },
            idempotencyKeyId: keyRow.id,
          };
        },
      }
    );
    return result;
  });

const readPreparedTopUp = async (principalUserId: string, topUpId: string) => {
  const [record] = await db
    .select()
    .from(paymentTopUp)
    .where(and(eq(paymentTopUp.id, topUpId), eq(paymentTopUp.userId, principalUserId)));
  if (!record) throw new MoneyDomainError('TOP_UP_NOT_FOUND', 'Top-up does not exist.');
  return record;
};

const finalizeProviderResponse = async (
  input: InitiateTopUpInput,
  prepared: PreparedTopUp,
  response: InboundPaymentResponse
) =>
  db.transaction(async (transaction) => {
    const [record] = await transaction
      .select()
      .from(paymentTopUp)
      .where(
        and(eq(paymentTopUp.id, prepared.topUp.id), eq(paymentTopUp.userId, input.principalUserId))
      )
      .for('update');
    if (!record) throw new MoneyDomainError('TOP_UP_NOT_FOUND', 'Top-up does not exist.');
    if (record.topUpStatus !== 'PENDING') return topUpFromRecord(record);
    if (response.providerAmountSatang !== record.paymentTotalSatang) {
      throw new InboundPaymentProviderError(
        'PROVIDER_UNCERTAIN',
        'Provider amount does not match the Top-up.'
      );
    }
    const [updated] = await transaction
      .update(paymentTopUp)
      .set({
        providerReference: response.providerReference,
        providerApiVersion: response.providerApiVersion,
        providerStatus: response.providerStatus,
        providerAmountSatang: response.providerAmountSatang,
        providerChannelCode: response.providerChannelCode,
        qrPayload: response.qrPayload,
        qrExpiresAt: response.qrExpiresAt,
        updatedAt: new Date(),
      })
      .where(eq(paymentTopUp.id, record.id))
      .returning();
    if (!updated)
      throw new MoneyDomainError(
        'TOP_UP_UPDATE_FAILED',
        'Top-up provider state could not be saved.'
      );
    await completeMoneyCommand(transaction, prepared.idempotencyKeyId);
    return topUpFromRecord(updated);
  });

const finalizeProviderRejection = async (
  input: InitiateTopUpInput,
  prepared: PreparedTopUp,
  error: InboundPaymentProviderError
) =>
  db.transaction(async (transaction) => {
    const [record] = await transaction
      .select()
      .from(paymentTopUp)
      .where(
        and(eq(paymentTopUp.id, prepared.topUp.id), eq(paymentTopUp.userId, input.principalUserId))
      )
      .for('update');
    if (!record) throw new MoneyDomainError('TOP_UP_NOT_FOUND', 'Top-up does not exist.');
    if (record.topUpStatus !== 'PENDING') return topUpFromRecord(record);
    const [updated] = await transaction
      .update(paymentTopUp)
      .set({
        providerStatus: error.providerCode ?? error.code,
        providerApiVersion: error.providerApiVersion,
        updatedAt: new Date(),
        topUpStatus: 'FAILED',
      })
      .where(eq(paymentTopUp.id, record.id))
      .returning();
    if (!updated)
      throw new MoneyDomainError('TOP_UP_UPDATE_FAILED', 'Failed Top-up state could not be saved.');
    await transaction.insert(paymentTopUpStatusHistory).values({
      topUpId: record.id,
      fromStatus: 'PENDING',
      toStatus: 'FAILED',
      providerStatus: error.providerCode ?? error.code,
      source: 'PROVIDER',
      reason: error.message,
    });
    await completeMoneyCommand(transaction, prepared.idempotencyKeyId);
    return topUpFromRecord(updated);
  });

const asProviderError = (error: unknown) =>
  error instanceof InboundPaymentProviderError
    ? error
    : new InboundPaymentProviderError('PROVIDER_UNCERTAIN', 'Provider response is uncertain.');

export const initiateTopUp = async (
  input: InitiateTopUpInput,
  provider: InboundPaymentProvider = new XenditPromptPayProvider()
): Promise<TopUp> => {
  const requestHash = await sha256Json({ quoteId: input.quoteId });
  const prepared = await prepareTopUp(input, requestHash);
  if (
    prepared.topUp.providerReference ||
    (prepared.topUp.topUpStatus !== 'PENDING' && prepared.topUp.providerStatus)
  ) {
    return prepared.topUp;
  }

  try {
    const response = await provider.createPayment(prepared.paymentRequest);
    return finalizeProviderResponse(input, prepared, response);
  } catch (reason: unknown) {
    const error = asProviderError(reason);
    if (error.code !== 'PROVIDER_REJECTED') throw error;
    const failed = await finalizeProviderRejection(input, prepared, error);
    throw Object.assign(error, { topUp: failed });
  }
};

export const getTopUp = async (principalUserId: string, topUpId: string) =>
  topUpFromRecord(await readPreparedTopUp(principalUserId, topUpId));

export const listTopUps = async (principalUserId: string, limit = 50) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new MoneyDomainError('INVALID_LIMIT', 'Top-up limit must be between 1 and 100.');
  }
  const records = await db
    .select()
    .from(paymentTopUp)
    .where(eq(paymentTopUp.userId, principalUserId))
    .orderBy(desc(paymentTopUp.createdAt), desc(paymentTopUp.id))
    .limit(limit);
  return records.map(topUpFromRecord);
};

export const listTopUpStatusHistory = async (principalUserId: string, topUpId: string) => {
  await readPreparedTopUp(principalUserId, topUpId);
  return db
    .select()
    .from(paymentTopUpStatusHistory)
    .where(eq(paymentTopUpStatusHistory.topUpId, topUpId))
    .orderBy(asc(paymentTopUpStatusHistory.occurredAt), asc(paymentTopUpStatusHistory.id));
};

export const createTopUpQuote = quoteTopUp;
export const createTopUp = initiateTopUp;
export const readTopUp = getTopUp;
