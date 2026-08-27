import {
  paymentMoneyPolicyRevision,
  walletActivity,
  walletFundingReservation,
  walletFundingReservationOperation,
  walletFundingReservationSettlement,
  walletIdempotencyKey,
  walletLedgerAccount,
  walletLedgerPosting,
  walletLedgerTransaction,
  walletWallet,
} from '@/database/schema/wallet.schema';

import { and, desc, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';

import {
  MAX_WALLET_CAPACITY_SATANG,
  MoneyDomainError,
  calculatePlatformFeeSatang,
  type Satang,
  positiveSatang,
  satang,
} from './wallet.money';
import { assertWalletOperationAllowed } from './wallet.status.service';
import { ensureWalletInTransaction, type WalletTransaction } from './wallet.service';

export type ReserveSpendingInput = {
  ownerUserId: string;
  callerScope: string;
  callerReference: string;
  amountSatang: Satang;
};

export type IncreaseFundingReservationInput = {
  ownerUserId: string;
  reservationId: string;
  operationReference: string;
  amountSatang: Satang;
};

export type ReleaseFundingReservationInput = {
  ownerUserId: string;
  reservationId: string;
  operationReference: string;
};

export type SettleFundingReservationInput = {
  ownerUserId: string;
  reservationId: string;
  settlementReference: string;
  recipientUserId: string;
  recipientAmountSatang: Satang;
  platformFeeSatang?: Satang;
};

const requireOpaqueReference = (value: string, field: string) => {
  if (value.trim().length === 0) {
    throw new MoneyDomainError('INVALID_CALLER_REFERENCE', `${field} must not be empty.`);
  }
};

const sha256Json = async (value: object) => {
  const payload = JSON.stringify(value);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const idempotencyExpiry = () => new Date(Date.now() + 24 * 60 * 60 * 1000);

const effectivePolicyInTransaction = async (transaction: WalletTransaction, at = new Date()) => {
  const policies = await transaction
    .select()
    .from(paymentMoneyPolicyRevision)
    .where(and(
      lte(paymentMoneyPolicyRevision.effectiveFrom, at),
      or(isNull(paymentMoneyPolicyRevision.effectiveUntil), gt(paymentMoneyPolicyRevision.effectiveUntil, at)),
    ))
    .orderBy(desc(paymentMoneyPolicyRevision.revision))
    .limit(2);

  if (policies.length > 1) {
    throw new MoneyDomainError('POLICY_OVERLAP', 'More than one Money Policy is effective.');
  }
  if (!policies[0]) {
    throw new MoneyDomainError('POLICY_NOT_AVAILABLE', 'No Money Policy is effective at this time.');
  }
  return policies[0];
};

const policyRevisionInTransaction = async (transaction: WalletTransaction, policyRevisionId: string) => {
  const [policy] = await transaction
    .select()
    .from(paymentMoneyPolicyRevision)
    .where(eq(paymentMoneyPolicyRevision.id, policyRevisionId));
  if (!policy) {
    throw new MoneyDomainError('POLICY_NOT_AVAILABLE', 'Funding Reservation Money Policy is missing.');
  }
  return policy;
};

export const getEffectiveFundingReservationPolicy = async (transaction: WalletTransaction) =>
  effectivePolicyInTransaction(transaction);

const walletAccountIds = async (transaction: WalletTransaction, walletId: string) => {
  const accounts = await transaction
    .select({ id: walletLedgerAccount.id, type: walletLedgerAccount.type })
    .from(walletLedgerAccount)
    .where(eq(walletLedgerAccount.walletId, walletId));
  return new Map(accounts.map(({ id, type }) => [type, id]));
};

const acquireIdempotency = async (
  transaction: WalletTransaction,
  principalUserId: string,
  operationScope: string,
  key: string,
  requestHash: string,
) => {
  const [created] = await transaction
    .insert(walletIdempotencyKey)
    .values({
      principalUserId,
      operationScope,
      key,
      requestHash,
      expiresAt: idempotencyExpiry(),
    })
    .onConflictDoNothing()
    .returning();
  const [idempotency] = created
    ? [created]
    : await transaction
      .select()
      .from(walletIdempotencyKey)
      .where(and(
        eq(walletIdempotencyKey.principalUserId, principalUserId),
        eq(walletIdempotencyKey.operationScope, operationScope),
        eq(walletIdempotencyKey.key, key),
      ))
      .for('update');

  if (!idempotency) {
    throw new MoneyDomainError('IDEMPOTENCY_UNAVAILABLE', 'Idempotency key could not be acquired.');
  }
  if (idempotency.requestHash !== requestHash) {
    throw new MoneyDomainError('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with a different request.');
  }

  return { created: Boolean(created), idempotency };
};

const replayFundingOperation = async (
  transaction: WalletTransaction,
  idempotencyKeyId: string,
) => {
  const [operation] = await transaction
    .select()
    .from(walletFundingReservationOperation)
    .where(eq(walletFundingReservationOperation.idempotencyKeyId, idempotencyKeyId));
  if (!operation) {
    throw new MoneyDomainError('IDEMPOTENCY_UNAVAILABLE', 'The idempotent Funding Reservation operation is missing.');
  }

  const [reservation] = await transaction
    .select()
    .from(walletFundingReservation)
    .where(eq(walletFundingReservation.id, operation.reservationId));
  if (!reservation) {
    throw new MoneyDomainError('IDEMPOTENCY_UNAVAILABLE', 'The idempotent Funding Reservation is missing.');
  }

  return reservation;
};

const completeFundingOperation = async (
  transaction: WalletTransaction,
  values: typeof walletFundingReservationOperation.$inferInsert,
) => {
  const [operation] = await transaction
    .insert(walletFundingReservationOperation)
    .values(values)
    .returning();
  if (!operation) {
    throw new MoneyDomainError('FUNDING_RESERVATION_OPERATION_FAILED', 'Funding Reservation operation could not be created.');
  }

  await transaction
    .update(walletIdempotencyKey)
    .set({
      resourceType: 'wallet_funding_reservation_operation',
      resourceId: operation.id,
      processingStatus: 'COMPLETED',
      completedAt: new Date(),
    })
    .where(eq(walletIdempotencyKey.id, values.idempotencyKeyId));

  return operation;
};

export const reserveSpending = async (
  transaction: WalletTransaction,
  input: ReserveSpendingInput,
) => {
  requireOpaqueReference(input.callerScope, 'Caller scope');
  requireOpaqueReference(input.callerReference, 'Caller reference');
  const amountSatang = positiveSatang(input.amountSatang);
  const operationScope = `wallet.funding-reservation:${input.callerScope}`;
  const requestHash = await sha256Json({
    callerScope: input.callerScope,
    callerReference: input.callerReference,
    amountSatang,
  });
  const { created, idempotency } = await acquireIdempotency(
    transaction,
    input.ownerUserId,
    operationScope,
    input.callerReference,
    requestHash,
  );
  if (idempotency.resourceId) return replayFundingOperation(transaction, idempotency.id);
  if (!created) {
    throw new MoneyDomainError('IDEMPOTENCY_IN_PROGRESS', 'A Funding Reservation operation is still processing.');
  }

  const policy = await effectivePolicyInTransaction(transaction);
  if (
    amountSatang < policy.minimumFundingReservationSatang ||
    amountSatang > policy.maximumFundingReservationSatang
  ) {
    throw new MoneyDomainError('AMOUNT_OUT_OF_RANGE', 'Amount is outside the active Money Policy limits.');
  }

  const [wallet] = await transaction
    .select()
    .from(walletWallet)
    .where(eq(walletWallet.userId, input.ownerUserId))
    .for('update');
  if (!wallet) throw new MoneyDomainError('WALLET_NOT_FOUND', 'Wallet does not exist.');
  assertWalletOperationAllowed(wallet.walletStatus, 'FUNDING_RESERVATION');
  if (wallet.spendingBalanceSatang < amountSatang) {
    throw new MoneyDomainError('INSUFFICIENT_SPENDING_BALANCE', 'Spending Balance is insufficient.');
  }

  const accounts = await walletAccountIds(transaction, wallet.id);
  const spendingAccountId = accounts.get('SPENDING');
  const fundingReservedAccountId = accounts.get('FUNDING_RESERVED');
  if (!spendingAccountId || !fundingReservedAccountId) {
    throw new MoneyDomainError('WALLET_ACCOUNT_NOT_FOUND', 'Required Wallet ledger account does not exist.');
  }

  const [ledgerTransaction] = await transaction
    .insert(walletLedgerTransaction)
    .values({
      businessReference: `funding-reservation:${JSON.stringify([
        input.ownerUserId,
        input.callerScope,
        input.callerReference,
      ])}`,
      eventType: 'FUNDING_RESERVE',
      idempotencyKeyId: idempotency.id,
      createdByUserId: input.ownerUserId,
      description: 'Reserve Spending for a caller-owned workflow',
    })
    .returning();
  if (!ledgerTransaction) {
    throw new MoneyDomainError('LEDGER_CREATE_FAILED', 'Ledger transaction could not be created.');
  }

  const [reservation] = await transaction
    .insert(walletFundingReservation)
    .values({
      walletId: wallet.id,
      ownerUserId: input.ownerUserId,
      callerScope: input.callerScope,
      callerReference: input.callerReference,
      policyRevisionId: policy.id,
      totalReservedSatang: amountSatang,
      remainingSatang: amountSatang,
      createdLedgerTransactionId: ledgerTransaction.id,
    })
    .onConflictDoNothing()
    .returning();
  if (!reservation) {
    throw new MoneyDomainError(
      'FUNDING_RESERVATION_EXISTS',
      'Caller reference already identifies a Funding Reservation in this scope.',
    );
  }

  await transaction.insert(walletLedgerPosting).values([
    { transactionId: ledgerTransaction.id, accountId: spendingAccountId, amountSatang: -amountSatang },
    { transactionId: ledgerTransaction.id, accountId: fundingReservedAccountId, amountSatang },
  ]);
  await transaction
    .update(walletLedgerTransaction)
    .set({ sealedAt: new Date() })
    .where(eq(walletLedgerTransaction.id, ledgerTransaction.id));
  await transaction
    .update(walletWallet)
    .set({
      spendingBalanceSatang: wallet.spendingBalanceSatang - amountSatang,
      fundingReservedSatang: wallet.fundingReservedSatang + amountSatang,
      updatedAt: new Date(),
    })
    .where(eq(walletWallet.id, wallet.id));
  await transaction.insert(walletActivity).values({
    ledgerTransactionId: ledgerTransaction.id,
    userId: input.ownerUserId,
    type: 'HOLD',
    activityStatus: 'COMPLETED',
    spendingDeltaSatang: -amountSatang,
    fundingReservedDeltaSatang: amountSatang,
    resourceType: 'wallet_ledger_transaction',
    resourceId: ledgerTransaction.id,
  });

  await completeFundingOperation(transaction, {
    reservationId: reservation.id,
    operationType: 'RESERVE',
    operationReference: input.callerReference,
    amountSatang,
    resultingTotalReservedSatang: reservation.totalReservedSatang,
    resultingRemainingSatang: reservation.remainingSatang,
    resultingStatus: reservation.status,
    ledgerTransactionId: ledgerTransaction.id,
    idempotencyKeyId: idempotency.id,
  });

  return reservation;
};

export const increaseFundingReservation = async (
  transaction: WalletTransaction,
  input: IncreaseFundingReservationInput,
) => {
  requireOpaqueReference(input.operationReference, 'Operation reference');
  const amountSatang = positiveSatang(input.amountSatang);
  const operationScope = `wallet.funding-reservation:${input.reservationId}`;
  const requestHash = await sha256Json({
    reservationId: input.reservationId,
    amountSatang,
  });
  const { created, idempotency } = await acquireIdempotency(
    transaction,
    input.ownerUserId,
    operationScope,
    input.operationReference,
    requestHash,
  );
  if (idempotency.resourceId) return replayFundingOperation(transaction, idempotency.id);
  if (!created) {
    throw new MoneyDomainError('IDEMPOTENCY_IN_PROGRESS', 'A Funding Reservation operation is still processing.');
  }

  const [reservation] = await transaction
    .select()
    .from(walletFundingReservation)
    .where(and(
      eq(walletFundingReservation.id, input.reservationId),
      eq(walletFundingReservation.ownerUserId, input.ownerUserId),
    ))
    .for('update');
  if (!reservation) {
    throw new MoneyDomainError('FUNDING_RESERVATION_NOT_FOUND', 'Funding Reservation does not exist.');
  }
  if (reservation.status !== 'ACTIVE') {
    throw new MoneyDomainError('FUNDING_RESERVATION_NOT_ACTIVE', 'Funding Reservation is not active.');
  }
  const policy = await policyRevisionInTransaction(transaction, reservation.policyRevisionId);
  if (
    amountSatang < policy.minimumFundingReservationSatang ||
    amountSatang > policy.maximumFundingReservationSatang
  ) {
    throw new MoneyDomainError('AMOUNT_OUT_OF_RANGE', 'Amount is outside the snapshotted Money Policy limits.');
  }
  if (reservation.totalReservedSatang + amountSatang > MAX_WALLET_CAPACITY_SATANG) {
    throw new MoneyDomainError('FUNDING_RESERVATION_CAPACITY_EXCEEDED', 'Funding Reservation exceeds capacity.');
  }

  const [wallet] = await transaction
    .select()
    .from(walletWallet)
    .where(eq(walletWallet.id, reservation.walletId))
    .for('update');
  if (!wallet) throw new MoneyDomainError('WALLET_NOT_FOUND', 'Wallet does not exist.');
  assertWalletOperationAllowed(wallet.walletStatus, 'FUNDING_RESERVATION');
  if (wallet.spendingBalanceSatang < amountSatang) {
    throw new MoneyDomainError('INSUFFICIENT_SPENDING_BALANCE', 'Spending Balance is insufficient.');
  }

  const accounts = await walletAccountIds(transaction, wallet.id);
  const spendingAccountId = accounts.get('SPENDING');
  const fundingReservedAccountId = accounts.get('FUNDING_RESERVED');
  if (!spendingAccountId || !fundingReservedAccountId) {
    throw new MoneyDomainError('WALLET_ACCOUNT_NOT_FOUND', 'Required Wallet ledger account does not exist.');
  }

  const [ledgerTransaction] = await transaction
    .insert(walletLedgerTransaction)
    .values({
      businessReference: `funding-reservation-increase:${JSON.stringify([
        reservation.id,
        input.operationReference,
      ])}`,
      eventType: 'FUNDING_RESERVE',
      idempotencyKeyId: idempotency.id,
      createdByUserId: input.ownerUserId,
      description: 'Increase a Funding Reservation',
    })
    .returning();
  if (!ledgerTransaction) {
    throw new MoneyDomainError('LEDGER_CREATE_FAILED', 'Ledger transaction could not be created.');
  }

  await transaction.insert(walletLedgerPosting).values([
    { transactionId: ledgerTransaction.id, accountId: spendingAccountId, amountSatang: -amountSatang },
    { transactionId: ledgerTransaction.id, accountId: fundingReservedAccountId, amountSatang },
  ]);
  await transaction
    .update(walletLedgerTransaction)
    .set({ sealedAt: new Date() })
    .where(eq(walletLedgerTransaction.id, ledgerTransaction.id));
  const [updatedReservation] = await transaction
    .update(walletFundingReservation)
    .set({
      totalReservedSatang: reservation.totalReservedSatang + amountSatang,
      remainingSatang: reservation.remainingSatang + amountSatang,
      updatedAt: new Date(),
    })
    .where(eq(walletFundingReservation.id, reservation.id))
    .returning();
  await transaction
    .update(walletWallet)
    .set({
      spendingBalanceSatang: wallet.spendingBalanceSatang - amountSatang,
      fundingReservedSatang: wallet.fundingReservedSatang + amountSatang,
      updatedAt: new Date(),
    })
    .where(eq(walletWallet.id, wallet.id));
  await transaction.insert(walletActivity).values({
    ledgerTransactionId: ledgerTransaction.id,
    userId: input.ownerUserId,
    type: 'HOLD',
    activityStatus: 'COMPLETED',
    spendingDeltaSatang: -amountSatang,
    fundingReservedDeltaSatang: amountSatang,
    resourceType: 'wallet_ledger_transaction',
    resourceId: ledgerTransaction.id,
  });

  if (!updatedReservation) {
    throw new MoneyDomainError('FUNDING_RESERVATION_OPERATION_FAILED', 'Funding Reservation could not be increased.');
  }
  await completeFundingOperation(transaction, {
    reservationId: updatedReservation.id,
    operationType: 'INCREASE',
    operationReference: input.operationReference,
    amountSatang,
    resultingTotalReservedSatang: updatedReservation.totalReservedSatang,
    resultingRemainingSatang: updatedReservation.remainingSatang,
    resultingStatus: updatedReservation.status,
    ledgerTransactionId: ledgerTransaction.id,
    idempotencyKeyId: idempotency.id,
  });

  return updatedReservation;
};

export const releaseFundingReservation = async (
  transaction: WalletTransaction,
  input: ReleaseFundingReservationInput,
) => {
  requireOpaqueReference(input.operationReference, 'Operation reference');
  const operationScope = `wallet.funding-reservation:${input.reservationId}`;
  const requestHash = await sha256Json({ reservationId: input.reservationId });
  const { created, idempotency } = await acquireIdempotency(
    transaction,
    input.ownerUserId,
    operationScope,
    input.operationReference,
    requestHash,
  );
  if (idempotency.resourceId) return replayFundingOperation(transaction, idempotency.id);
  if (!created) {
    throw new MoneyDomainError('IDEMPOTENCY_IN_PROGRESS', 'A Funding Reservation operation is still processing.');
  }

  const [reservation] = await transaction
    .select()
    .from(walletFundingReservation)
    .where(and(
      eq(walletFundingReservation.id, input.reservationId),
      eq(walletFundingReservation.ownerUserId, input.ownerUserId),
    ))
    .for('update');
  if (!reservation) {
    throw new MoneyDomainError('FUNDING_RESERVATION_NOT_FOUND', 'Funding Reservation does not exist.');
  }
  if (reservation.status !== 'ACTIVE') {
    throw new MoneyDomainError('FUNDING_RESERVATION_NOT_ACTIVE', 'Funding Reservation is not active.');
  }

  const [wallet] = await transaction
    .select()
    .from(walletWallet)
    .where(eq(walletWallet.id, reservation.walletId))
    .for('update');
  if (!wallet) throw new MoneyDomainError('WALLET_NOT_FOUND', 'Wallet does not exist.');
  if (wallet.fundingReservedSatang < reservation.remainingSatang) {
    throw new MoneyDomainError('INVALID_LEDGER_BALANCE', 'Funding reserved projection is inconsistent.');
  }

  const accounts = await walletAccountIds(transaction, wallet.id);
  const spendingAccountId = accounts.get('SPENDING');
  const fundingReservedAccountId = accounts.get('FUNDING_RESERVED');
  if (!spendingAccountId || !fundingReservedAccountId) {
    throw new MoneyDomainError('WALLET_ACCOUNT_NOT_FOUND', 'Required Wallet ledger account does not exist.');
  }

  const amountSatang = reservation.remainingSatang;
  const [ledgerTransaction] = await transaction
    .insert(walletLedgerTransaction)
    .values({
      businessReference: `funding-reservation-release:${JSON.stringify([
        reservation.id,
        input.operationReference,
      ])}`,
      eventType: 'FUNDING_RELEASE',
      idempotencyKeyId: idempotency.id,
      createdByUserId: input.ownerUserId,
      description: 'Release a Funding Reservation',
    })
    .returning();
  if (!ledgerTransaction) {
    throw new MoneyDomainError('LEDGER_CREATE_FAILED', 'Ledger transaction could not be created.');
  }

  await transaction.insert(walletLedgerPosting).values([
    { transactionId: ledgerTransaction.id, accountId: fundingReservedAccountId, amountSatang: -amountSatang },
    { transactionId: ledgerTransaction.id, accountId: spendingAccountId, amountSatang },
  ]);
  await transaction
    .update(walletLedgerTransaction)
    .set({ sealedAt: new Date() })
    .where(eq(walletLedgerTransaction.id, ledgerTransaction.id));
  const [updatedReservation] = await transaction
    .update(walletFundingReservation)
    .set({ remainingSatang: 0, status: 'RELEASED', updatedAt: new Date() })
    .where(eq(walletFundingReservation.id, reservation.id))
    .returning();
  await transaction
    .update(walletWallet)
    .set({
      spendingBalanceSatang: wallet.spendingBalanceSatang + amountSatang,
      fundingReservedSatang: wallet.fundingReservedSatang - amountSatang,
      updatedAt: new Date(),
    })
    .where(eq(walletWallet.id, wallet.id));
  await transaction.insert(walletActivity).values({
    ledgerTransactionId: ledgerTransaction.id,
    userId: input.ownerUserId,
    type: 'RELEASE',
    activityStatus: 'COMPLETED',
    spendingDeltaSatang: amountSatang,
    fundingReservedDeltaSatang: -amountSatang,
    resourceType: 'wallet_ledger_transaction',
    resourceId: ledgerTransaction.id,
  });

  if (!updatedReservation) {
    throw new MoneyDomainError('FUNDING_RESERVATION_OPERATION_FAILED', 'Funding Reservation could not be released.');
  }
  await completeFundingOperation(transaction, {
    reservationId: updatedReservation.id,
    operationType: 'RELEASE',
    operationReference: input.operationReference,
    amountSatang,
    resultingTotalReservedSatang: updatedReservation.totalReservedSatang,
    resultingRemainingSatang: updatedReservation.remainingSatang,
    resultingStatus: updatedReservation.status,
    ledgerTransactionId: ledgerTransaction.id,
    idempotencyKeyId: idempotency.id,
  });

  return updatedReservation;
};

export const settleFundingReservation = async (
  transaction: WalletTransaction,
  input: SettleFundingReservationInput,
) => {
  requireOpaqueReference(input.settlementReference, 'Settlement reference');
  const recipientAmountSatang = positiveSatang(input.recipientAmountSatang);
  const platformFeeSatang = satang(input.platformFeeSatang ?? 0);
  const [reservationSnapshot] = await transaction
    .select()
    .from(walletFundingReservation)
    .where(and(
      eq(walletFundingReservation.id, input.reservationId),
      eq(walletFundingReservation.ownerUserId, input.ownerUserId),
    ));
  if (!reservationSnapshot) {
    throw new MoneyDomainError('FUNDING_RESERVATION_NOT_FOUND', 'Funding Reservation does not exist.');
  }
  const policy = await policyRevisionInTransaction(transaction, reservationSnapshot.policyRevisionId);
  const snapshottedPlatformFeeSatang = calculatePlatformFeeSatang(
    recipientAmountSatang,
    policy.platformFeeBps,
  );
  if (platformFeeSatang > 0 && platformFeeSatang !== snapshottedPlatformFeeSatang) {
    throw new MoneyDomainError(
      'PLATFORM_FEE_MISMATCH',
      'Platform Fee does not match the Funding Reservation Money Policy.',
    );
  }
  const totalAmountSatang = recipientAmountSatang + platformFeeSatang;
  if (!Number.isSafeInteger(totalAmountSatang) || totalAmountSatang > MAX_WALLET_CAPACITY_SATANG) {
    throw new MoneyDomainError('SATANG_OVERFLOW', 'Settlement amount exceeds Wallet capacity.');
  }

  const operationScope = `wallet.funding-settlement:${input.reservationId}`;
  const requestHash = await sha256Json({
    recipientUserId: input.recipientUserId,
    recipientAmountSatang,
    platformFeeSatang,
  });
  const [createdIdempotency] = await transaction
    .insert(walletIdempotencyKey)
    .values({
      principalUserId: input.ownerUserId,
      operationScope,
      key: input.settlementReference,
      requestHash,
      expiresAt: idempotencyExpiry(),
    })
    .onConflictDoNothing()
    .returning();
  const [idempotency] = createdIdempotency
    ? [createdIdempotency]
    : await transaction
      .select()
      .from(walletIdempotencyKey)
      .where(and(
        eq(walletIdempotencyKey.principalUserId, input.ownerUserId),
        eq(walletIdempotencyKey.operationScope, operationScope),
        eq(walletIdempotencyKey.key, input.settlementReference),
      ))
      .for('update');
  if (!idempotency) {
    throw new MoneyDomainError('IDEMPOTENCY_UNAVAILABLE', 'Idempotency key could not be acquired.');
  }
  if (idempotency.requestHash !== requestHash) {
    throw new MoneyDomainError('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with a different request.');
  }
  if (idempotency.resourceId) {
    const [replayed] = await transaction
      .select()
      .from(walletFundingReservationSettlement)
      .where(eq(walletFundingReservationSettlement.id, idempotency.resourceId));
    if (!replayed) {
      throw new MoneyDomainError('IDEMPOTENCY_UNAVAILABLE', 'The idempotent settlement record is missing.');
    }
    return replayed;
  }
  if (!createdIdempotency) {
    throw new MoneyDomainError('IDEMPOTENCY_IN_PROGRESS', 'A settlement with this key is still processing.');
  }

  const [reservation] = await transaction
    .select()
    .from(walletFundingReservation)
    .where(and(
      eq(walletFundingReservation.id, input.reservationId),
      eq(walletFundingReservation.ownerUserId, input.ownerUserId),
    ))
    .for('update');
  if (!reservation) {
    throw new MoneyDomainError('FUNDING_RESERVATION_NOT_FOUND', 'Funding Reservation does not exist.');
  }
  if (reservation.status !== 'ACTIVE') {
    throw new MoneyDomainError('FUNDING_RESERVATION_NOT_ACTIVE', 'Funding Reservation is not active.');
  }
  if (reservation.remainingSatang < totalAmountSatang) {
    throw new MoneyDomainError('FUNDING_RESERVATION_INSUFFICIENT', 'Settlement exceeds remaining reservation funds.');
  }

  const recipientWallet = await ensureWalletInTransaction(transaction, input.recipientUserId);
  const walletIds = [...new Set([reservation.walletId, recipientWallet.id])].sort();
  const wallets = await transaction
    .select()
    .from(walletWallet)
    .where(inArray(walletWallet.id, walletIds))
    .orderBy(walletWallet.id)
    .for('update');
  const ownerWallet = wallets.find(({ id }) => id === reservation.walletId);
  const lockedRecipientWallet = wallets.find(({ id }) => id === recipientWallet.id);
  if (!ownerWallet || !lockedRecipientWallet) {
    throw new MoneyDomainError('WALLET_NOT_FOUND', 'Settlement Wallet does not exist.');
  }
  if (ownerWallet.fundingReservedSatang < totalAmountSatang) {
    throw new MoneyDomainError('INVALID_LEDGER_BALANCE', 'Funding reserved projection is inconsistent.');
  }
  const recipientTotal = lockedRecipientWallet.spendingBalanceSatang +
    lockedRecipientWallet.earningsBalanceSatang +
    lockedRecipientWallet.fundingReservedSatang +
    lockedRecipientWallet.reservedForPayoutsSatang;
  if (
    ownerWallet.id !== lockedRecipientWallet.id &&
    recipientTotal + recipientAmountSatang > MAX_WALLET_CAPACITY_SATANG
  ) {
    throw new MoneyDomainError('WALLET_CAPACITY_EXCEEDED', 'Recipient Wallet capacity would be exceeded.');
  }

  const ownerAccounts = await walletAccountIds(transaction, ownerWallet.id);
  const recipientAccounts = ownerWallet.id === lockedRecipientWallet.id
    ? ownerAccounts
    : await walletAccountIds(transaction, lockedRecipientWallet.id);
  const fundingReservedAccountId = ownerAccounts.get('FUNDING_RESERVED');
  const recipientEarningsAccountId = recipientAccounts.get('EARNINGS');
  const [platformRevenueAccount] = platformFeeSatang === 0
    ? [undefined]
    : await transaction
      .select({ id: walletLedgerAccount.id })
      .from(walletLedgerAccount)
      .where(eq(walletLedgerAccount.code, 'platform:PLATFORM_REVENUE'));
  if (!fundingReservedAccountId || !recipientEarningsAccountId || (platformFeeSatang > 0 && !platformRevenueAccount)) {
    throw new MoneyDomainError('WALLET_ACCOUNT_NOT_FOUND', 'Required settlement ledger account does not exist.');
  }

  const businessReference = `funding-settlement:${await sha256Json({
    reservationId: reservation.id,
    settlementReference: input.settlementReference,
  })}`;
  const [ledgerTransaction] = await transaction
    .insert(walletLedgerTransaction)
    .values({
      businessReference,
      eventType: 'FUNDING_SETTLEMENT',
      idempotencyKeyId: idempotency.id,
      createdByUserId: input.ownerUserId,
      description: 'Settle a Funding Reservation',
    })
    .returning();
  if (!ledgerTransaction) {
    throw new MoneyDomainError('LEDGER_CREATE_FAILED', 'Ledger transaction could not be created.');
  }

  const [settlement] = await transaction
    .insert(walletFundingReservationSettlement)
    .values({
      reservationId: reservation.id,
      settlementReference: input.settlementReference,
      recipientWalletId: lockedRecipientWallet.id,
      recipientUserId: input.recipientUserId,
      recipientAmountSatang,
      platformFeeSatang,
      totalAmountSatang,
      ledgerTransactionId: ledgerTransaction.id,
      idempotencyKeyId: idempotency.id,
    })
    .returning();
  if (!settlement) {
    throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'Funding Reservation settlement could not be created.');
  }

  await transaction.insert(walletLedgerPosting).values([
    {
      transactionId: ledgerTransaction.id,
      accountId: fundingReservedAccountId,
      amountSatang: -totalAmountSatang,
    },
    {
      transactionId: ledgerTransaction.id,
      accountId: recipientEarningsAccountId,
      amountSatang: recipientAmountSatang,
    },
    ...(platformRevenueAccount
      ? [{
        transactionId: ledgerTransaction.id,
        accountId: platformRevenueAccount.id,
        amountSatang: platformFeeSatang,
      }]
      : []),
  ]);
  await transaction
    .update(walletLedgerTransaction)
    .set({ sealedAt: new Date() })
    .where(eq(walletLedgerTransaction.id, ledgerTransaction.id));

  const remainingSatang = reservation.remainingSatang - totalAmountSatang;
  await transaction
    .update(walletFundingReservation)
    .set({
      remainingSatang,
      status: remainingSatang === 0 ? 'SETTLED' : 'ACTIVE',
      updatedAt: new Date(),
    })
    .where(eq(walletFundingReservation.id, reservation.id));
  await transaction
    .update(walletWallet)
    .set({
      fundingReservedSatang: ownerWallet.fundingReservedSatang - totalAmountSatang,
      updatedAt: new Date(),
    })
    .where(eq(walletWallet.id, ownerWallet.id));
  await transaction
    .update(walletWallet)
    .set({
      earningsBalanceSatang: lockedRecipientWallet.earningsBalanceSatang + recipientAmountSatang,
      updatedAt: new Date(),
    })
    .where(eq(walletWallet.id, lockedRecipientWallet.id));

  if (input.ownerUserId === input.recipientUserId) {
    await transaction.insert(walletActivity).values({
      ledgerTransactionId: ledgerTransaction.id,
      userId: input.ownerUserId,
      type: 'EARN',
      activityStatus: 'COMPLETED',
      earningsDeltaSatang: recipientAmountSatang,
      fundingReservedDeltaSatang: -totalAmountSatang,
      resourceType: 'wallet_ledger_transaction',
      resourceId: ledgerTransaction.id,
    });
  } else {
    await transaction.insert(walletActivity).values([
      {
        ledgerTransactionId: ledgerTransaction.id,
        userId: input.ownerUserId,
        type: 'SPEND',
        activityStatus: 'COMPLETED',
        fundingReservedDeltaSatang: -totalAmountSatang,
        resourceType: 'wallet_ledger_transaction',
        resourceId: ledgerTransaction.id,
      },
      {
        ledgerTransactionId: ledgerTransaction.id,
        userId: input.recipientUserId,
        type: 'EARN',
        activityStatus: 'COMPLETED',
        earningsDeltaSatang: recipientAmountSatang,
        resourceType: 'wallet_ledger_transaction',
        resourceId: ledgerTransaction.id,
      },
    ]);
  }
  await transaction
    .update(walletIdempotencyKey)
    .set({
      resourceType: 'wallet_funding_reservation_settlement',
      resourceId: settlement.id,
      processingStatus: 'COMPLETED',
      completedAt: new Date(),
    })
    .where(eq(walletIdempotencyKey.id, idempotency.id));

  return settlement;
};
