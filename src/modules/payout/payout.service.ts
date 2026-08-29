import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import {
  paymentPayoutAccounts,
  paymentPayoutQuotes,
  paymentPayoutStatusHistory,
  paymentPayouts,
  type PayoutStatus,
} from '@/database/schema/payment.schema';
import {
  walletIdempotencyKey,
  walletLedgerAccount,
  walletWallet,
} from '@/database/schema/wallet.schema';
import {
  createPayoutDestinationEncryption,
  payoutDestinationForProvider,
  type PayoutDestination,
  type PayoutDestinationEncryption,
  type PayoutDestinationForProvider,
} from '@/modules/payout-destination';
import {
  MAX_WALLET_CAPACITY_SATANG,
  MoneyDomainError,
  positiveSatang,
  satang,
  signedSatang,
  type Satang,
} from '@/modules/wallet/wallet.money';
import { assertWalletOperationAllowed } from '@/modules/wallet/wallet.status.service';
import {
  createSealedLedgerTransactionInTransaction,
  ensureWalletInTransaction,
  getEffectiveMoneyPolicy,
  validateOperationAmount,
} from '@/modules/wallet/wallet.service';
import type { WalletTransaction } from '@/modules/wallet/wallet.service';

import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';

import {
  PayoutProviderError,
  type OutboundPayoutProvider,
  type OutboundPayoutResponse,
  XenditPayoutProvider,
} from './payout.provider';

export const payoutOperationScope = 'wallet.payout';

export type PayoutQuoteInput = {
  principalUserId: string;
  receiptSatang: Satang;
};

export type PayoutQuote = {
  id: string;
  principalUserId: string;
  payoutDestinationId: string;
  policyRevisionId: string;
  receiptSatang: Satang;
  maximumFeeSatang: Satang;
  maximumTaxSatang: Satang;
  maximumDebitSatang: Satang;
  feeRoundingMode: 'UP';
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
};

export type InitiatePayoutInput = {
  principalUserId: string;
  quoteId: string;
  idempotency: { key: string };
};

export type Payout = {
  id: string;
  internalReference: string;
  principalUserId: string;
  quoteId: string;
  payoutDestinationId: string;
  destinationRecipientType: string;
  destinationGivenName: string;
  destinationSurname: string;
  destinationRelationship: string;
  destinationAccountCountry: string;
  destinationAccountCurrency: string;
  destinationBankCode: string;
  destinationAccountHolderName: string;
  destinationRoutingType: string;
  destinationMaskedLastFour: string;
  destinationMaskedRoutingValue: string;
  provider: string;
  providerReference: string | null;
  providerApiVersion: string | null;
  providerStatus: string | null;
  providerAmountSatang: Satang | null;
  principalSatang: Satang;
  receiptSatang: Satang;
  maximumFeeSatang: Satang;
  maximumTaxSatang: Satang;
  maximumDebitSatang: Satang;
  actualFeeSatang: Satang | null;
  actualTaxSatang: Satang | null;
  actualDebitSatang: Satang | null;
  payoutStatus: PayoutStatus;
  reserveLedgerTransactionId: string;
  finalLedgerTransactionId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const idempotencyExpiry = () => new Date(Date.now() + 24 * 60 * 60 * 1000);

const sha256Json = async (value: object) => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const validateTotal = (values: number[]) => {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total) || total <= 0 || total > MAX_WALLET_CAPACITY_SATANG) {
    throw new MoneyDomainError('SATANG_OVERFLOW', 'The Payout amount exceeds the Wallet capacity.');
  }
  return positiveSatang(total);
};

const quoteFromRecord = (record: typeof paymentPayoutQuotes.$inferSelect): PayoutQuote => ({
  id: record.id,
  principalUserId: record.userId,
  payoutDestinationId: record.payoutAccountId,
  policyRevisionId: record.policyRevisionId,
  receiptSatang: positiveSatang(record.receiptSatang),
  maximumFeeSatang: satang(record.maximumFeeSatang),
  maximumTaxSatang: satang(record.maximumTaxSatang),
  maximumDebitSatang: positiveSatang(record.maximumDebitSatang),
  feeRoundingMode: 'UP',
  expiresAt: record.expiresAt,
  consumedAt: record.consumedAt,
  createdAt: record.createdAt,
});

const optionalSatang = (value: number | null) => value === null ? null : satang(value);

const payoutFromRecord = (record: typeof paymentPayouts.$inferSelect): Payout => ({
  id: record.id,
  internalReference: record.internalReference,
  principalUserId: record.userId,
  quoteId: record.quoteId,
  payoutDestinationId: record.payoutAccountId,
  destinationRecipientType: record.destinationRecipientType,
  destinationGivenName: record.destinationGivenName,
  destinationSurname: record.destinationSurname,
  destinationRelationship: record.destinationRelationship,
  destinationAccountCountry: record.destinationAccountCountry,
  destinationAccountCurrency: record.destinationAccountCurrency,
  destinationBankCode: record.destinationBankCode,
  destinationAccountHolderName: record.destinationAccountHolderName,
  destinationRoutingType: record.destinationRoutingType,
  destinationMaskedLastFour: record.destinationMaskedLastFour,
  destinationMaskedRoutingValue: record.destinationMaskedRoutingValue,
  provider: record.provider,
  providerReference: record.providerReference,
  providerApiVersion: record.providerApiVersion,
  providerStatus: record.providerStatus,
  providerAmountSatang: optionalSatang(record.providerAmountSatang),
  principalSatang: positiveSatang(record.principalSatang),
  receiptSatang: positiveSatang(record.principalSatang),
  maximumFeeSatang: satang(record.maximumFeeSatang),
  maximumTaxSatang: satang(record.maximumTaxSatang),
  maximumDebitSatang: positiveSatang(record.maximumDebitSatang),
  actualFeeSatang: optionalSatang(record.actualFeeSatang),
  actualTaxSatang: optionalSatang(record.actualTaxSatang),
  actualDebitSatang: optionalSatang(record.actualDebitSatang),
  payoutStatus: record.payoutStatus,
  reserveLedgerTransactionId: record.reserveLedgerTransactionId,
  finalLedgerTransactionId: record.finalLedgerTransactionId,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

const payoutDestinationFromSnapshot = (payout: Payout): PayoutDestination => ({
  id: payout.payoutDestinationId,
  principalUserId: payout.principalUserId,
  recipientType: 'SELF',
  givenName: payout.destinationGivenName,
  surname: payout.destinationSurname,
  relationship: payout.destinationRelationship,
  accountCountry: 'TH',
  accountCurrency: 'THB',
  bankCode: payout.destinationBankCode,
  accountHolderName: payout.destinationAccountHolderName,
  routingType: payout.destinationRoutingType as 'BANK_ACCOUNT' | 'PROMPTPAY',
  maskedLastFour: payout.destinationMaskedLastFour,
  maskedRoutingValue: payout.destinationMaskedRoutingValue,
  createdAt: payout.createdAt,
  retiredAt: null,
});

const calculatePayoutTerms = (receiptSatang: Satang, policy: {
  payoutProviderFeeSatang: number;
  payoutProviderTaxBps: number;
}) => {
  const maximumFeeSatang = satang(policy.payoutProviderFeeSatang);
  const maximumTaxSatang = satang(Math.ceil(
    (maximumFeeSatang * policy.payoutProviderTaxBps) / 10_000,
  ));
  return {
    maximumFeeSatang,
    maximumTaxSatang,
    maximumDebitSatang: validateTotal([receiptSatang, maximumFeeSatang, maximumTaxSatang]),
  };
};

export const quotePayout = async (input: PayoutQuoteInput): Promise<PayoutQuote> => {
  const [member] = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.id, input.principalUserId))
    .limit(1);
  if (!member) throw new MoneyDomainError('MEMBER_NOT_FOUND', 'Member does not exist.');

  const [wallet] = await db
    .select({ walletStatus: walletWallet.walletStatus })
    .from(walletWallet)
    .where(eq(walletWallet.userId, input.principalUserId))
    .limit(1);
  if (!wallet) throw new MoneyDomainError('WALLET_NOT_FOUND', 'Wallet does not exist.');
  assertWalletOperationAllowed(wallet.walletStatus, 'PAYOUT');

  const policy = await getEffectiveMoneyPolicy();
  const receiptSatang = validateOperationAmount(
    input.receiptSatang,
    policy.minimumPayoutSatang,
    policy.maximumPayoutSatang,
  );
  const terms = calculatePayoutTerms(receiptSatang, policy);
  const [created] = await db.transaction(async (transaction) => {
    const [destination] = await transaction
      .select()
      .from(paymentPayoutAccounts)
      .where(and(
        eq(paymentPayoutAccounts.userId, input.principalUserId),
        isNull(paymentPayoutAccounts.retiredAt),
      ))
      .for('update');
    if (!destination) {
      throw new MoneyDomainError('PAYOUT_DESTINATION_NOT_FOUND', 'Active Payout Destination does not exist.');
    }
    return transaction
      .insert(paymentPayoutQuotes)
      .values({
        userId: input.principalUserId,
        payoutAccountId: destination.id,
        policyRevisionId: policy.id,
        feeRoundingMode: policy.feeRoundingMode as 'UP',
        receiptSatang,
        ...terms,
        expiresAt: new Date(Date.now() + policy.quoteLifetimeSeconds * 1000),
      })
      .returning();
  });
  if (!created) throw new MoneyDomainError('PAYOUT_QUOTE_CREATE_FAILED', 'Payout Quote could not be created.');
  return quoteFromRecord(created);
};

type PreparedPayout = {
  payout: Payout;
  idempotencyKeyId: string | null;
};

const acquireInitiationIdempotency = async (
  transaction: WalletTransaction,
  input: InitiatePayoutInput,
  requestHash: string,
) => {
  if (input.idempotency.key.trim().length === 0) {
    throw new MoneyDomainError('IDEMPOTENCY_UNAVAILABLE', 'Idempotency key must not be empty.');
  }
  const [created] = await transaction
    .insert(walletIdempotencyKey)
    .values({
      principalUserId: input.principalUserId,
      operationScope: payoutOperationScope,
      key: input.idempotency.key,
      requestHash,
      expiresAt: idempotencyExpiry(),
    })
    .onConflictDoNothing()
    .returning();
  const [record] = created
    ? [created]
    : await transaction
      .select()
      .from(walletIdempotencyKey)
      .where(and(
        eq(walletIdempotencyKey.principalUserId, input.principalUserId),
        eq(walletIdempotencyKey.operationScope, payoutOperationScope),
        eq(walletIdempotencyKey.key, input.idempotency.key),
      ))
      .for('update');
  if (!record) throw new MoneyDomainError('IDEMPOTENCY_UNAVAILABLE', 'Idempotency key could not be acquired.');
  if (record.requestHash !== requestHash) {
    throw new MoneyDomainError('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with a different request.');
  }
  if (record.resourceId) {
    const [replayed] = await transaction
      .select()
      .from(paymentPayouts)
      .where(and(eq(paymentPayouts.id, record.resourceId), eq(paymentPayouts.userId, input.principalUserId)));
    if (!replayed) throw new MoneyDomainError('IDEMPOTENCY_UNAVAILABLE', 'The idempotent Payout record is missing.');
    return { record, replay: payoutFromRecord(replayed) };
  }
  if (!created) throw new MoneyDomainError('IDEMPOTENCY_IN_PROGRESS', 'A Payout with this idempotency key is still processing.');
  return { record, replay: undefined };
};

const accountIdsForPayout = async (transaction: WalletTransaction, walletId: string) => {
  const accounts = await transaction
    .select({ id: walletLedgerAccount.id, type: walletLedgerAccount.type })
    .from(walletLedgerAccount)
    .where(and(
      eq(walletLedgerAccount.walletId, walletId),
      inArray(walletLedgerAccount.type, ['EARNINGS', 'RESERVED_FOR_PAYOUTS']),
    ))
    .for('update');
  const earnings = accounts.find(({ type }) => type === 'EARNINGS');
  const payoutReserve = accounts.find(({ type }) => type === 'RESERVED_FOR_PAYOUTS');
  if (!earnings || !payoutReserve) {
    throw new MoneyDomainError('WALLET_ACCOUNT_NOT_FOUND', 'Payout Wallet accounts do not exist.');
  }
  return { earningsId: earnings.id, payoutReserveId: payoutReserve.id };
};

const preparePayout = async (
  input: InitiatePayoutInput,
  requestHash: string,
): Promise<PreparedPayout> => db.transaction(async (transaction) => {
  const idempotency = await acquireInitiationIdempotency(transaction, input, requestHash);
  if (idempotency.replay) {
    return { payout: idempotency.replay, idempotencyKeyId: idempotency.record.id };
  }

  const wallet = await ensureWalletInTransaction(transaction, input.principalUserId);
  const [lockedWallet] = await transaction
    .select()
    .from(walletWallet)
    .where(eq(walletWallet.id, wallet.id))
    .for('update');
  if (!lockedWallet) throw new MoneyDomainError('WALLET_NOT_FOUND', 'Wallet does not exist.');
  assertWalletOperationAllowed(lockedWallet.walletStatus, 'PAYOUT');

  const [active] = await transaction
    .select({ id: paymentPayouts.id })
    .from(paymentPayouts)
    .where(and(
      eq(paymentPayouts.userId, input.principalUserId),
      inArray(paymentPayouts.payoutStatus, ['PENDING_ADMIN_APPROVAL', 'CREATING', 'PENDING', 'AWAITING_RECONCILIATION']),
    ))
    .limit(1);
  if (active) throw new MoneyDomainError('PAYOUT_ACTIVE_EXISTS', 'The Student already has an active Payout.');

  const [quote] = await transaction
    .select()
    .from(paymentPayoutQuotes)
    .where(and(
      eq(paymentPayoutQuotes.id, input.quoteId),
      eq(paymentPayoutQuotes.userId, input.principalUserId),
    ))
    .for('update');
  if (!quote) throw new MoneyDomainError('PAYOUT_QUOTE_NOT_FOUND', 'Payout Quote does not exist.');
  if (quote.consumedAt) throw new MoneyDomainError('PAYOUT_QUOTE_CONSUMED', 'Payout Quote was already consumed.');
  if (quote.expiresAt <= new Date()) throw new MoneyDomainError('PAYOUT_QUOTE_EXPIRED', 'Payout Quote has expired.');

  const [destination] = await transaction
    .select()
    .from(paymentPayoutAccounts)
    .where(and(
      eq(paymentPayoutAccounts.id, quote.payoutAccountId),
      eq(paymentPayoutAccounts.userId, input.principalUserId),
      isNull(paymentPayoutAccounts.retiredAt),
    ))
    .for('update');
  if (!destination) throw new MoneyDomainError('PAYOUT_DESTINATION_NOT_FOUND', 'Active Payout Destination does not exist.');
  if (lockedWallet.earningsBalanceSatang < quote.maximumDebitSatang) {
    throw new MoneyDomainError('INSUFFICIENT_EARNINGS_BALANCE', 'Earnings Balance is insufficient for the Payout reserve.');
  }

  const { earningsId, payoutReserveId } = await accountIdsForPayout(transaction, lockedWallet.id);
  const payoutId = crypto.randomUUID();
  const reserveLedger = await createSealedLedgerTransactionInTransaction(transaction, {
    businessReference: `payout-reserve:${payoutId}`,
    eventType: 'PAYOUT',
    createdByUserId: input.principalUserId,
    description: 'Reserve Earnings Balance for Payout',
    postings: [
      { accountId: earningsId, amountSatang: signedSatang(-quote.maximumDebitSatang) },
      { accountId: payoutReserveId, amountSatang: signedSatang(quote.maximumDebitSatang) },
    ],
  });
  if (!reserveLedger) throw new MoneyDomainError('PAYOUT_CREATE_FAILED', 'Payout reserve could not be created.');

  const internalReference = `payout:${payoutId}`;
  const [created] = await transaction
    .insert(paymentPayouts)
    .values({
      id: payoutId,
      internalReference,
      userId: input.principalUserId,
      quoteId: quote.id,
      payoutAccountId: destination.id,
      destinationRecipientType: destination.recipientType,
      destinationGivenName: destination.givenName,
      destinationSurname: destination.surname,
      destinationRelationship: destination.relationship,
      destinationAccountCountry: destination.accountCountry,
      destinationAccountCurrency: destination.accountCurrency,
      destinationBankCode: destination.bankCode,
      destinationAccountNumberKeyVersion: destination.accountNumberKeyVersion,
      destinationAccountNumberNonce: destination.accountNumberNonce,
      destinationAccountNumberCiphertext: destination.accountNumberCiphertext,
      destinationAccountNumberAuthTag: destination.accountNumberAuthTag,
      destinationMaskedLastFour: destination.maskedLastFour,
      destinationAccountHolderName: destination.accountHolderName,
      destinationRoutingType: destination.routingType,
      destinationRoutingValueKeyVersion: destination.routingValueKeyVersion,
      destinationRoutingValueNonce: destination.routingValueNonce,
      destinationRoutingValueCiphertext: destination.routingValueCiphertext,
      destinationRoutingValueAuthTag: destination.routingValueAuthTag,
      destinationMaskedRoutingValue: destination.maskedRoutingValue,
      provider: 'XENDIT',
      principalSatang: quote.receiptSatang,
      maximumFeeSatang: quote.maximumFeeSatang,
      maximumTaxSatang: quote.maximumTaxSatang,
      maximumDebitSatang: quote.maximumDebitSatang,
      payoutStatus: 'PENDING_ADMIN_APPROVAL',
      reserveLedgerTransactionId: reserveLedger.id,
    })
    .returning();
  if (!created) throw new MoneyDomainError('PAYOUT_CREATE_FAILED', 'Payout could not be created.');
  await transaction.insert(paymentPayoutStatusHistory).values({
    payoutId: created.id,
    toStatus: 'PENDING_ADMIN_APPROVAL',
    source: 'INITIATION',
    actorUserId: input.principalUserId,
  });
  await transaction
    .update(paymentPayoutQuotes)
    .set({ consumedAt: new Date() })
    .where(eq(paymentPayoutQuotes.id, quote.id));
  await transaction
    .update(walletIdempotencyKey)
    .set({
      resourceType: 'payment_payout',
      resourceId: created.id,
      processingStatus: 'COMPLETED',
      completedAt: new Date(),
    })
    .where(eq(walletIdempotencyKey.id, idempotency.record.id));

  return { payout: payoutFromRecord(created), idempotencyKeyId: idempotency.record.id };
});

const providerRequestFor = async (
  prepared: PreparedPayout,
  encryption: PayoutDestinationEncryption,
): Promise<{
  internalReference: string;
  receiptSatang: Satang;
  maximumFeeSatang: Satang;
  maximumTaxSatang: Satang;
  maximumDebitSatang: Satang;
  destination: PayoutDestinationForProvider;
}> => {
  const [record] = await db
    .select()
    .from(paymentPayouts)
    .where(and(
      eq(paymentPayouts.id, prepared.payout.id),
      eq(paymentPayouts.userId, prepared.payout.principalUserId),
    ))
    .limit(1);
  if (!record) throw new MoneyDomainError('PAYOUT_NOT_FOUND', 'Payout does not exist.');

  const destination = payoutDestinationForProvider(
    payoutDestinationFromSnapshot(prepared.payout),
    {
      accountNumberKeyVersion: record.destinationAccountNumberKeyVersion,
      accountNumberNonce: record.destinationAccountNumberNonce,
      accountNumberCiphertext: record.destinationAccountNumberCiphertext,
      accountNumberAuthTag: record.destinationAccountNumberAuthTag,
      routingValueKeyVersion: record.destinationRoutingValueKeyVersion,
      routingValueNonce: record.destinationRoutingValueNonce,
      routingValueCiphertext: record.destinationRoutingValueCiphertext,
      routingValueAuthTag: record.destinationRoutingValueAuthTag,
    },
    encryption,
  );
  return {
    internalReference: prepared.payout.internalReference,
    receiptSatang: prepared.payout.receiptSatang,
    maximumFeeSatang: prepared.payout.maximumFeeSatang,
    maximumTaxSatang: prepared.payout.maximumTaxSatang,
    maximumDebitSatang: prepared.payout.maximumDebitSatang,
    destination,
  };
};

const finalizeProviderResponse = async (
  input: InitiatePayoutInput,
  prepared: PreparedPayout,
  response: OutboundPayoutResponse,
) => db.transaction(async (transaction) => {
  const [record] = await transaction
    .select()
    .from(paymentPayouts)
    .where(and(eq(paymentPayouts.id, prepared.payout.id), eq(paymentPayouts.userId, input.principalUserId)))
    .for('update');
  if (!record) throw new MoneyDomainError('PAYOUT_NOT_FOUND', 'Payout does not exist.');
  if (!['CREATING', 'AWAITING_RECONCILIATION'].includes(record.payoutStatus)) return payoutFromRecord(record);
  if (
    response.providerAmountSatang !== record.principalSatang ||
    response.actualDebitSatang !== record.principalSatang + response.actualFeeSatang + response.actualTaxSatang ||
    response.actualDebitSatang > record.maximumDebitSatang
  ) {
    throw new PayoutProviderError('PROVIDER_UNCERTAIN', 'Provider Payout amounts do not match the Quote.');
  }
  const [updated] = await transaction
    .update(paymentPayouts)
    .set({
      providerReference: response.providerReference,
      providerApiVersion: response.providerApiVersion,
      providerStatus: response.providerStatus,
      providerAmountSatang: response.providerAmountSatang,
      actualFeeSatang: response.actualFeeSatang,
      actualTaxSatang: response.actualTaxSatang,
      actualDebitSatang: response.actualDebitSatang,
      payoutStatus: 'PENDING',
      providerSubmissionClaimedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(paymentPayouts.id, record.id))
    .returning();
  if (!updated) throw new MoneyDomainError('PAYOUT_UPDATE_FAILED', 'Payout provider state could not be saved.');
  await transaction.insert(paymentPayoutStatusHistory).values({
    payoutId: record.id,
    fromStatus: record.payoutStatus,
    toStatus: 'PENDING',
    providerStatus: response.providerStatus,
    source: 'PROVIDER',
  });
  if (prepared.idempotencyKeyId) {
    await transaction
      .update(walletIdempotencyKey)
      .set({ processingStatus: 'COMPLETED', completedAt: new Date() })
      .where(eq(walletIdempotencyKey.id, prepared.idempotencyKeyId));
  }
  return payoutFromRecord(updated);
});

const finalizeUncertain = async (
  input: InitiatePayoutInput,
  prepared: PreparedPayout,
  error: PayoutProviderError,
) => db.transaction(async (transaction) => {
  const [record] = await transaction
    .select()
    .from(paymentPayouts)
    .where(and(eq(paymentPayouts.id, prepared.payout.id), eq(paymentPayouts.userId, input.principalUserId)))
    .for('update');
  if (!record) throw new MoneyDomainError('PAYOUT_NOT_FOUND', 'Payout does not exist.');
  if (!['CREATING', 'AWAITING_RECONCILIATION'].includes(record.payoutStatus)) return payoutFromRecord(record);
  const providerStatus = error.providerStatus?.toString() ?? error.code;
  const nextStatus = record.payoutStatus === 'CREATING' ? 'AWAITING_RECONCILIATION' : record.payoutStatus;
  const [updated] = await transaction
    .update(paymentPayouts)
    .set({
      providerApiVersion: error.providerApiVersion,
      providerStatus,
      payoutStatus: nextStatus,
      providerSubmissionClaimedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(paymentPayouts.id, record.id))
    .returning();
  if (!updated) throw new MoneyDomainError('PAYOUT_UPDATE_FAILED', 'Uncertain Payout state could not be saved.');
  if (nextStatus !== record.payoutStatus) {
    await transaction.insert(paymentPayoutStatusHistory).values({
      payoutId: record.id,
      fromStatus: record.payoutStatus,
      toStatus: nextStatus,
      providerStatus,
      source: 'PROVIDER',
      reason: 'Provider response is uncertain.',
    });
  }
  return payoutFromRecord(updated);
});

type PayoutFailureDetails = {
  providerApiVersion?: string;
  providerStatus: string;
  historyReason: string;
  historySource: 'INITIATION' | 'PROVIDER';
};

const finalizeFailed = async (
  input: InitiatePayoutInput,
  prepared: PreparedPayout,
  details: PayoutFailureDetails,
) => db.transaction(async (transaction) => {
  const [record] = await transaction
    .select()
    .from(paymentPayouts)
    .where(and(eq(paymentPayouts.id, prepared.payout.id), eq(paymentPayouts.userId, input.principalUserId)))
    .for('update');
  if (!record) throw new MoneyDomainError('PAYOUT_NOT_FOUND', 'Payout does not exist.');
  if (!['CREATING', 'AWAITING_RECONCILIATION'].includes(record.payoutStatus)) return payoutFromRecord(record);

  const wallet = await ensureWalletInTransaction(transaction, input.principalUserId);
  const { earningsId, payoutReserveId } = await accountIdsForPayout(transaction, wallet.id);
  const releaseLedger = await createSealedLedgerTransactionInTransaction(transaction, {
    businessReference: `payout-release:${record.id}`,
    eventType: 'PAYOUT',
    createdByUserId: input.principalUserId,
    description: 'Release failed Payout reserve',
    postings: [
      { accountId: earningsId, amountSatang: signedSatang(record.maximumDebitSatang) },
      { accountId: payoutReserveId, amountSatang: signedSatang(-record.maximumDebitSatang) },
    ],
  });
  if (!releaseLedger) {
    throw new MoneyDomainError('PAYOUT_UPDATE_FAILED', 'Failed Payout reserve could not be released.');
  }
  const [updated] = await transaction
    .update(paymentPayouts)
    .set({
      providerApiVersion: details.providerApiVersion,
      providerStatus: details.providerStatus,
      payoutStatus: 'FAILED',
      finalLedgerTransactionId: releaseLedger.id,
      providerSubmissionClaimedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(paymentPayouts.id, record.id))
    .returning();
  if (!updated) throw new MoneyDomainError('PAYOUT_UPDATE_FAILED', 'Failed Payout state could not be saved.');
  await transaction.insert(paymentPayoutStatusHistory).values({
    payoutId: record.id,
    fromStatus: record.payoutStatus,
    toStatus: 'FAILED',
    providerStatus: details.providerStatus,
    source: details.historySource,
    reason: details.historyReason,
  });
  if (prepared.idempotencyKeyId) {
    await transaction
      .update(walletIdempotencyKey)
      .set({ processingStatus: 'COMPLETED', completedAt: new Date() })
      .where(eq(walletIdempotencyKey.id, prepared.idempotencyKeyId));
  }
  return payoutFromRecord(updated);
});

const finalizeRejected = async (
  input: InitiatePayoutInput,
  prepared: PreparedPayout,
  error: PayoutProviderError,
) => finalizeFailed(input, prepared, {
  providerApiVersion: error.providerApiVersion,
  providerStatus: error.providerStatus?.toString() ?? error.code,
  historyReason: 'Provider rejected the Payout.',
  historySource: 'PROVIDER',
});

const finalizePreparationFailure = async (
  input: InitiatePayoutInput,
  prepared: PreparedPayout,
  error: PayoutProviderError | undefined,
) => finalizeFailed(input, prepared, {
  providerApiVersion: error?.providerApiVersion,
  providerStatus: error?.code ?? 'PAYOUT_PREPARATION_FAILED',
  historyReason: 'Payout could not be prepared for the Provider.',
  historySource: 'INITIATION',
});

const providerErrorMessage = (code: PayoutProviderError['code']) => {
  if (code === 'PROVIDER_REJECTED') return 'Provider rejected the Payout.';
  if (code === 'PROVIDER_CONFIGURATION') return 'Payout Provider is not configured.';
  return 'Provider response is uncertain.';
};

const safeProviderCode = (value: string | undefined) => (
  value && /^[A-Z][A-Z_]{0,63}$/.test(value) ? value : undefined
);

const asProviderError = (error: unknown) => {
  if (!(error instanceof PayoutProviderError)) {
    return new PayoutProviderError('PROVIDER_UNCERTAIN', 'Provider response is uncertain.');
  }
  return new PayoutProviderError(error.code, providerErrorMessage(error.code), {
    providerCode: safeProviderCode(error.providerCode),
    providerStatus: error.providerStatus,
    providerApiVersion: error.providerApiVersion,
  });
};

export const initiatePayout = async (
  input: InitiatePayoutInput,
  // Keep the former optional arguments for callers that only used this service as a submission seam.
  // They are intentionally ignored because Provider hand-off now belongs to the Worker.
  _provider?: OutboundPayoutProvider,
  _encryption?: PayoutDestinationEncryption,
): Promise<Payout> => {
  const requestHash = await sha256Json({ quoteId: input.quoteId });
  const prepared = await preparePayout(input, requestHash);
  return prepared.payout;
};

const providerSubmissionLeaseMs = 5 * 60 * 1000;

const claimApprovedPayout = async (payoutId: string) => db.transaction(async (transaction) => {
  const [record] = await transaction
    .select()
    .from(paymentPayouts)
    .where(eq(paymentPayouts.id, payoutId))
    .for('update');
  if (!record) throw new MoneyDomainError('PAYOUT_NOT_FOUND', 'Payout does not exist.');
  if (record.payoutStatus !== 'CREATING') return { payout: payoutFromRecord(record), claimed: false };

  const [approval] = await transaction
    .select({ id: paymentPayoutStatusHistory.id })
    .from(paymentPayoutStatusHistory)
    .where(and(
      eq(paymentPayoutStatusHistory.payoutId, record.id),
      eq(paymentPayoutStatusHistory.toStatus, 'CREATING'),
      eq(paymentPayoutStatusHistory.source, 'ADMIN_APPROVAL'),
      isNotNull(paymentPayoutStatusHistory.actorAdminId),
    ))
    .limit(1);
  if (!approval) return { payout: payoutFromRecord(record), claimed: false };

  const staleBefore = new Date(Date.now() - providerSubmissionLeaseMs);
  if (record.providerSubmissionClaimedAt && record.providerSubmissionClaimedAt >= staleBefore) {
    return { payout: payoutFromRecord(record), claimed: false };
  }

  const [claimed] = await transaction
    .update(paymentPayouts)
    .set({ providerSubmissionClaimedAt: new Date(), updatedAt: new Date() })
    .where(eq(paymentPayouts.id, record.id))
    .returning();
  if (!claimed) throw new MoneyDomainError('PAYOUT_UPDATE_FAILED', 'Payout could not be claimed by the Worker.');
  return { payout: payoutFromRecord(claimed), claimed: true };
});

export const processApprovedPayout = async (
  payoutId: string,
  provider: OutboundPayoutProvider = new XenditPayoutProvider(),
  encryption: PayoutDestinationEncryption = createPayoutDestinationEncryption(),
): Promise<Payout> => {
  const claim = await claimApprovedPayout(payoutId);
  if (!claim.claimed) return claim.payout;

  const prepared: PreparedPayout = { payout: claim.payout, idempotencyKeyId: null };
  const input: InitiatePayoutInput = {
    principalUserId: claim.payout.principalUserId,
    quoteId: claim.payout.quoteId,
    idempotency: { key: `payout-worker:${claim.payout.id}` },
  };
  let request: Awaited<ReturnType<typeof providerRequestFor>>;
  try {
    request = await providerRequestFor(prepared, encryption);
  } catch (reason: unknown) {
    await finalizePreparationFailure(
      input,
      prepared,
      reason instanceof PayoutProviderError ? asProviderError(reason) : undefined,
    );
    throw reason;
  }

  try {
    const response = await provider.createPayout(request);
    return finalizeProviderResponse(input, prepared, response);
  } catch (reason: unknown) {
    const error = asProviderError(reason);
    if (error.code === 'PROVIDER_REJECTED') {
      const failed = await finalizeRejected(input, prepared, error);
      throw Object.assign(error, { payout: failed });
    }
    if (error.code === 'PROVIDER_CONFIGURATION') {
      await finalizePreparationFailure(input, prepared, error);
      throw error;
    }
    await finalizeUncertain(input, prepared, error);
    throw error;
  }
};

export const processApprovedPayouts = async (
  limit = 20,
  provider: OutboundPayoutProvider = new XenditPayoutProvider(),
  encryption: PayoutDestinationEncryption = createPayoutDestinationEncryption(),
): Promise<number> => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new MoneyDomainError('INVALID_LIMIT', 'Payout Worker limit must be between 1 and 100.');
  }
  const staleBefore = new Date(Date.now() - providerSubmissionLeaseMs);
  const candidates = await db
    .select({ id: paymentPayouts.id })
    .from(paymentPayouts)
    .where(and(
      eq(paymentPayouts.payoutStatus, 'CREATING'),
      or(isNull(paymentPayouts.providerSubmissionClaimedAt), lt(paymentPayouts.providerSubmissionClaimedAt, staleBefore)),
    ))
    .orderBy(asc(paymentPayouts.createdAt), asc(paymentPayouts.id))
    .limit(limit);
  let processed = 0;
  for (const candidate of candidates) {
    try {
      // Process one Payout at a time to keep Wallet locks ordered.
      // eslint-disable-next-line no-await-in-loop
      const payout = await processApprovedPayout(candidate.id, provider, encryption);
      if (payout.payoutStatus !== 'CREATING') processed += 1;
    } catch {
      processed += 1;
    }
  }
  return processed;
};

const readPayoutRecord = async (principalUserId: string, payoutId: string) => {
  const [record] = await db
    .select()
    .from(paymentPayouts)
    .where(and(eq(paymentPayouts.id, payoutId), eq(paymentPayouts.userId, principalUserId)));
  if (!record) throw new MoneyDomainError('PAYOUT_NOT_FOUND', 'Payout does not exist.');
  return record;
};

export const getPayout = async (principalUserId: string, payoutId: string) =>
  payoutFromRecord(await readPayoutRecord(principalUserId, payoutId));

export const listPayouts = async (principalUserId: string, limit = 50) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new MoneyDomainError('INVALID_LIMIT', 'Payout limit must be between 1 and 100.');
  }
  const records = await db
    .select()
    .from(paymentPayouts)
    .where(eq(paymentPayouts.userId, principalUserId))
    .orderBy(desc(paymentPayouts.createdAt), desc(paymentPayouts.id))
    .limit(limit);
  return records.map(payoutFromRecord);
};

export const listPayoutStatusHistory = async (principalUserId: string, payoutId: string) => {
  await readPayoutRecord(principalUserId, payoutId);
  return db
    .select()
    .from(paymentPayoutStatusHistory)
    .where(eq(paymentPayoutStatusHistory.payoutId, payoutId))
    .orderBy(asc(paymentPayoutStatusHistory.occurredAt), asc(paymentPayoutStatusHistory.id));
};

export const createPayoutQuote = quotePayout;
export const createPayout = initiatePayout;
export const readPayout = getPayout;
