import {
  type FundingReservationStatus,
  paymentMoneyPolicyRevision,
  walletActivity,
  walletDisputeSettlement,
  walletFundingReservation,
  walletFundingReservationOperation,
  walletFundingReservationSettlement,
  walletLedgerAccount,
  walletLedgerPosting,
  walletLedgerTransaction,
  walletWallet,
} from '@/database/schema/wallet.schema';

import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';

import {
  MAX_WALLET_CAPACITY_SATANG,
  MoneyDomainError,
  calculatePlatformFeeSatang,
  type Satang,
  positiveSatang,
  satang,
  signedSatang,
} from './wallet.money';
import { completeMoneyCommand, runMoneyCommand } from './wallet.money-command.service';
import { assertWalletOperationAllowed, isWalletOperationAllowed } from './wallet.status.service';
import {
  createSealedLedgerTransactionInTransaction,
  ensureWalletInTransaction,
  type WalletTransaction,
} from './wallet.service';

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
  /** Use only when a Quest allocates the already snapshotted fee pool. */
  platformFeeValidation?: 'POLICY' | 'QUEST_ESCROW_SNAPSHOT';
};

export type SettleDisputeCaseInput = {
  ownerUserId: string;
  reservationId: string;
  settlementReference: string;
  recipientUserId: string;
  requestedAmountSatang: Satang;
};

export type SettleDisputeCaseResult = {
  ledgerTransactionId: string;
  recipientAmountSatang: Satang;
  reservationStatus: 'ACTIVE' | 'RELEASED' | 'SETTLED';
};

export type ReadFundingReservationInput = {
  ownerUserId: string;
  callerScope: string;
  callerReference: string;
};

export type FundingCapacityInput = {
  ownerUserId: string;
  requiredSatang: Satang;
};

export type PlatformFeeForReservationInput = {
  reservationId: string;
  rewardSatang: number;
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

const effectivePolicyInTransaction = async (transaction: WalletTransaction, at = new Date()) => {
  const policies = await transaction
    .select()
    .from(paymentMoneyPolicyRevision)
    .where(
      and(
        lte(paymentMoneyPolicyRevision.effectiveFrom, at),
        or(
          isNull(paymentMoneyPolicyRevision.effectiveUntil),
          gt(paymentMoneyPolicyRevision.effectiveUntil, at)
        )
      )
    )
    .orderBy(desc(paymentMoneyPolicyRevision.revision))
    .limit(2);

  if (policies.length > 1) {
    throw new MoneyDomainError('POLICY_OVERLAP', 'More than one Money Policy is effective.');
  }
  if (!policies[0]) {
    throw new MoneyDomainError(
      'POLICY_NOT_AVAILABLE',
      'No Money Policy is effective at this time.'
    );
  }
  return policies[0];
};

const policyRevisionInTransaction = async (
  transaction: WalletTransaction,
  policyRevisionId: string
) => {
  const [policy] = await transaction
    .select()
    .from(paymentMoneyPolicyRevision)
    .where(eq(paymentMoneyPolicyRevision.id, policyRevisionId));
  if (!policy) {
    throw new MoneyDomainError(
      'POLICY_NOT_AVAILABLE',
      'Funding Reservation Money Policy is missing.'
    );
  }
  return policy;
};

type DisputeAmountCalculation = {
  amountSatang: Satang;
  eligibleCapSatang: Satang;
};

/**
 * Calculate the exact authorized amount for an explicit Admin decision.
 *
 * Admin supplies the positive decision amount. Wallet calculates the eligible
 * cap from the retained Quest Funding Reservation facts and the active Money
 * Policy, then accepts the exact decision amount only when it fits that cap.
 * It never silently increases or truncates an Admin decision.
 */
const calculateDisputeResolutionAmountSatang = (
  requestedAmountSatang: Satang,
  questFundingAvailableSatang: number,
  activeMoneyPolicyMaximumSatang: number
): DisputeAmountCalculation => {
  const eligibleCapSatang = satang(
    Math.min(Math.max(questFundingAvailableSatang, 0), activeMoneyPolicyMaximumSatang)
  );
  if (requestedAmountSatang <= eligibleCapSatang) {
    return { amountSatang: requestedAmountSatang, eligibleCapSatang };
  }
  if (requestedAmountSatang > activeMoneyPolicyMaximumSatang) {
    throw new MoneyDomainError(
      'AMOUNT_OUT_OF_RANGE',
      'Dispute amount is outside the active Money Policy limit.'
    );
  }
  throw new MoneyDomainError(
    'FUNDING_RESERVATION_INSUFFICIENT',
    'Dispute amount exceeds the remaining Quest Funding Reservation cap.'
  );
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

const replayFundingOperation = async (transaction: WalletTransaction, idempotencyKeyId: string) => {
  const [operation] = await transaction
    .select()
    .from(walletFundingReservationOperation)
    .where(eq(walletFundingReservationOperation.idempotencyKeyId, idempotencyKeyId));
  if (!operation) {
    throw new MoneyDomainError(
      'IDEMPOTENCY_UNAVAILABLE',
      'The idempotent Funding Reservation operation is missing.'
    );
  }

  const [reservation] = await transaction
    .select()
    .from(walletFundingReservation)
    .where(eq(walletFundingReservation.id, operation.reservationId));
  if (!reservation) {
    throw new MoneyDomainError(
      'IDEMPOTENCY_UNAVAILABLE',
      'The idempotent Funding Reservation is missing.'
    );
  }

  return { reservation, operation };
};

const completeFundingOperation = async (
  transaction: WalletTransaction,
  keyId: string,
  values: typeof walletFundingReservationOperation.$inferInsert
) => {
  const [operation] = await transaction
    .insert(walletFundingReservationOperation)
    .values(values)
    .returning();
  if (!operation) {
    throw new MoneyDomainError(
      'FUNDING_RESERVATION_OPERATION_FAILED',
      'Funding Reservation operation could not be created.'
    );
  }

  await completeMoneyCommand(
    transaction,
    keyId,
    'wallet_funding_reservation_operation',
    operation.id
  );
};

export const reserveSpending = async (
  transaction: WalletTransaction,
  input: ReserveSpendingInput
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
  const { result } = await runMoneyCommand(
    transaction,
    {
      principalUserId: input.ownerUserId,
      scope: operationScope,
      key: input.callerReference,
      requestHash,
    },
    {
      execute: async (transaction, keyId) => {
        const policy = await effectivePolicyInTransaction(transaction);
        if (
          amountSatang < policy.minimumFundingReservationSatang ||
          amountSatang > policy.maximumFundingReservationSatang
        ) {
          throw new MoneyDomainError(
            'AMOUNT_OUT_OF_RANGE',
            'Amount is outside the active Money Policy limits.'
          );
        }

        const [wallet] = await transaction
          .select()
          .from(walletWallet)
          .where(eq(walletWallet.userId, input.ownerUserId))
          .for('update');
        if (!wallet) throw new MoneyDomainError('WALLET_NOT_FOUND', 'Wallet does not exist.');
        assertWalletOperationAllowed(wallet.walletStatus, 'FUNDING_RESERVATION');
        if (wallet.spendingBalanceSatang < amountSatang) {
          throw new MoneyDomainError(
            'INSUFFICIENT_SPENDING_BALANCE',
            'Spending Balance is insufficient.'
          );
        }

        const accounts = await walletAccountIds(transaction, wallet.id);
        const spendingAccountId = accounts.get('SPENDING');
        const fundingReservedAccountId = accounts.get('FUNDING_RESERVED');
        if (!spendingAccountId || !fundingReservedAccountId) {
          throw new MoneyDomainError(
            'WALLET_ACCOUNT_NOT_FOUND',
            'Required Wallet ledger account does not exist.'
          );
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
            idempotencyKeyId: keyId,
            createdByUserId: input.ownerUserId,
            description: 'Reserve Spending for a caller-owned workflow',
          })
          .returning();
        if (!ledgerTransaction) {
          throw new MoneyDomainError(
            'LEDGER_CREATE_FAILED',
            'Ledger transaction could not be created.'
          );
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
            'Caller reference already identifies a Funding Reservation in this scope.'
          );
        }

        await transaction.insert(walletLedgerPosting).values([
          {
            transactionId: ledgerTransaction.id,
            accountId: spendingAccountId,
            amountSatang: -amountSatang,
          },
          {
            transactionId: ledgerTransaction.id,
            accountId: fundingReservedAccountId,
            amountSatang,
          },
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

        await completeFundingOperation(transaction, keyId, {
          reservationId: reservation.id,
          operationType: 'RESERVE',
          operationReference: input.callerReference,
          amountSatang,
          resultingTotalReservedSatang: reservation.totalReservedSatang,
          resultingRemainingSatang: reservation.remainingSatang,
          resultingStatus: reservation.status,
          ledgerTransactionId: ledgerTransaction.id,
          idempotencyKeyId: keyId,
        });

        return reservation;
      },
      replay: async (transaction, keyRow) => {
        const { reservation } = await replayFundingOperation(transaction, keyRow.id);
        return reservation;
      },
    }
  );
  return result;
};

export const increaseFundingReservation = async (
  transaction: WalletTransaction,
  input: IncreaseFundingReservationInput
) => {
  requireOpaqueReference(input.operationReference, 'Operation reference');
  const amountSatang = positiveSatang(input.amountSatang);
  const operationScope = `wallet.funding-reservation:${input.reservationId}`;
  const requestHash = await sha256Json({
    reservationId: input.reservationId,
    amountSatang,
  });
  const { result } = await runMoneyCommand(
    transaction,
    {
      principalUserId: input.ownerUserId,
      scope: operationScope,
      key: input.operationReference,
      requestHash,
    },
    {
      execute: async (transaction, keyId) => {
        const [reservation] = await transaction
          .select()
          .from(walletFundingReservation)
          .where(
            and(
              eq(walletFundingReservation.id, input.reservationId),
              eq(walletFundingReservation.ownerUserId, input.ownerUserId)
            )
          )
          .for('update');
        if (!reservation) {
          throw new MoneyDomainError(
            'FUNDING_RESERVATION_NOT_FOUND',
            'Funding Reservation does not exist.'
          );
        }
        if (reservation.status !== 'ACTIVE') {
          throw new MoneyDomainError(
            'FUNDING_RESERVATION_NOT_ACTIVE',
            'Funding Reservation is not active.'
          );
        }
        const policy = await policyRevisionInTransaction(transaction, reservation.policyRevisionId);
        if (
          amountSatang < policy.minimumFundingReservationSatang ||
          amountSatang > policy.maximumFundingReservationSatang
        ) {
          throw new MoneyDomainError(
            'AMOUNT_OUT_OF_RANGE',
            'Amount is outside the snapshotted Money Policy limits.'
          );
        }
        if (reservation.totalReservedSatang + amountSatang > MAX_WALLET_CAPACITY_SATANG) {
          throw new MoneyDomainError(
            'FUNDING_RESERVATION_CAPACITY_EXCEEDED',
            'Funding Reservation exceeds capacity.'
          );
        }

        const [wallet] = await transaction
          .select()
          .from(walletWallet)
          .where(eq(walletWallet.id, reservation.walletId))
          .for('update');
        if (!wallet) throw new MoneyDomainError('WALLET_NOT_FOUND', 'Wallet does not exist.');
        assertWalletOperationAllowed(wallet.walletStatus, 'FUNDING_RESERVATION');
        if (wallet.spendingBalanceSatang < amountSatang) {
          throw new MoneyDomainError(
            'INSUFFICIENT_SPENDING_BALANCE',
            'Spending Balance is insufficient.'
          );
        }

        const accounts = await walletAccountIds(transaction, wallet.id);
        const spendingAccountId = accounts.get('SPENDING');
        const fundingReservedAccountId = accounts.get('FUNDING_RESERVED');
        if (!spendingAccountId || !fundingReservedAccountId) {
          throw new MoneyDomainError(
            'WALLET_ACCOUNT_NOT_FOUND',
            'Required Wallet ledger account does not exist.'
          );
        }

        const [ledgerTransaction] = await transaction
          .insert(walletLedgerTransaction)
          .values({
            businessReference: `funding-reservation-increase:${JSON.stringify([
              reservation.id,
              input.operationReference,
            ])}`,
            eventType: 'FUNDING_RESERVE',
            idempotencyKeyId: keyId,
            createdByUserId: input.ownerUserId,
            description: 'Increase a Funding Reservation',
          })
          .returning();
        if (!ledgerTransaction) {
          throw new MoneyDomainError(
            'LEDGER_CREATE_FAILED',
            'Ledger transaction could not be created.'
          );
        }

        await transaction.insert(walletLedgerPosting).values([
          {
            transactionId: ledgerTransaction.id,
            accountId: spendingAccountId,
            amountSatang: -amountSatang,
          },
          {
            transactionId: ledgerTransaction.id,
            accountId: fundingReservedAccountId,
            amountSatang,
          },
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
          throw new MoneyDomainError(
            'FUNDING_RESERVATION_OPERATION_FAILED',
            'Funding Reservation could not be increased.'
          );
        }
        await completeFundingOperation(transaction, keyId, {
          reservationId: updatedReservation.id,
          operationType: 'INCREASE',
          operationReference: input.operationReference,
          amountSatang,
          resultingTotalReservedSatang: updatedReservation.totalReservedSatang,
          resultingRemainingSatang: updatedReservation.remainingSatang,
          resultingStatus: updatedReservation.status,
          ledgerTransactionId: ledgerTransaction.id,
          idempotencyKeyId: keyId,
        });

        return updatedReservation;
      },
      replay: async (transaction, keyRow) => {
        const { reservation } = await replayFundingOperation(transaction, keyRow.id);
        return reservation;
      },
    }
  );
  return result;
};

export const releaseFundingReservation = async (
  transaction: WalletTransaction,
  input: ReleaseFundingReservationInput
) => {
  requireOpaqueReference(input.operationReference, 'Operation reference');
  const operationScope = `wallet.funding-reservation:${input.reservationId}`;
  const requestHash = await sha256Json({ reservationId: input.reservationId });
  const { result } = await runMoneyCommand(
    transaction,
    {
      principalUserId: input.ownerUserId,
      scope: operationScope,
      key: input.operationReference,
      requestHash,
    },
    {
      execute: async (transaction, keyId) => {
        const [reservation] = await transaction
          .select()
          .from(walletFundingReservation)
          .where(
            and(
              eq(walletFundingReservation.id, input.reservationId),
              eq(walletFundingReservation.ownerUserId, input.ownerUserId)
            )
          )
          .for('update');
        if (!reservation) {
          throw new MoneyDomainError(
            'FUNDING_RESERVATION_NOT_FOUND',
            'Funding Reservation does not exist.'
          );
        }
        if (reservation.status !== 'ACTIVE') {
          await completeMoneyCommand(transaction, keyId, null, null);
          return { ...reservation, releasedSatang: satang(0) };
        }

        const [wallet] = await transaction
          .select()
          .from(walletWallet)
          .where(eq(walletWallet.id, reservation.walletId))
          .for('update');
        if (!wallet) throw new MoneyDomainError('WALLET_NOT_FOUND', 'Wallet does not exist.');
        if (wallet.fundingReservedSatang < reservation.remainingSatang) {
          throw new MoneyDomainError(
            'INVALID_LEDGER_BALANCE',
            'Funding reserved projection is inconsistent.'
          );
        }

        const accounts = await walletAccountIds(transaction, wallet.id);
        const spendingAccountId = accounts.get('SPENDING');
        const fundingReservedAccountId = accounts.get('FUNDING_RESERVED');
        if (!spendingAccountId || !fundingReservedAccountId) {
          throw new MoneyDomainError(
            'WALLET_ACCOUNT_NOT_FOUND',
            'Required Wallet ledger account does not exist.'
          );
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
            idempotencyKeyId: keyId,
            createdByUserId: input.ownerUserId,
            description: 'Release a Funding Reservation',
          })
          .returning();
        if (!ledgerTransaction) {
          throw new MoneyDomainError(
            'LEDGER_CREATE_FAILED',
            'Ledger transaction could not be created.'
          );
        }

        await transaction.insert(walletLedgerPosting).values([
          {
            transactionId: ledgerTransaction.id,
            accountId: fundingReservedAccountId,
            amountSatang: -amountSatang,
          },
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
          throw new MoneyDomainError(
            'FUNDING_RESERVATION_OPERATION_FAILED',
            'Funding Reservation could not be released.'
          );
        }
        await completeFundingOperation(transaction, keyId, {
          reservationId: updatedReservation.id,
          operationType: 'RELEASE',
          operationReference: input.operationReference,
          amountSatang,
          resultingTotalReservedSatang: updatedReservation.totalReservedSatang,
          resultingRemainingSatang: updatedReservation.remainingSatang,
          resultingStatus: updatedReservation.status,
          ledgerTransactionId: ledgerTransaction.id,
          idempotencyKeyId: keyId,
        });

        return { ...updatedReservation, releasedSatang: satang(amountSatang) };
      },
      replay: async (transaction, keyRow) => {
        if (keyRow.resourceId) {
          const { reservation, operation } = await replayFundingOperation(transaction, keyRow.id);
          return {
            ...reservation,
            releasedSatang: satang(
              operation.operationType === 'RELEASE' ? operation.amountSatang : 0
            ),
          };
        }
        const [released] = await transaction
          .select()
          .from(walletFundingReservation)
          .where(
            and(
              eq(walletFundingReservation.id, input.reservationId),
              eq(walletFundingReservation.ownerUserId, input.ownerUserId)
            )
          );
        if (!released) {
          throw new MoneyDomainError(
            'FUNDING_RESERVATION_NOT_FOUND',
            'Funding Reservation does not exist.'
          );
        }
        return { ...released, releasedSatang: satang(0) };
      },
    }
  );
  return result;
};

export const settleFundingReservation = async (
  transaction: WalletTransaction,
  input: SettleFundingReservationInput
) => {
  requireOpaqueReference(input.settlementReference, 'Settlement reference');
  const recipientAmountSatang = positiveSatang(input.recipientAmountSatang);
  const platformFeeSatang = satang(input.platformFeeSatang ?? 0);
  const [reservationSnapshot] = await transaction
    .select()
    .from(walletFundingReservation)
    .where(
      and(
        eq(walletFundingReservation.id, input.reservationId),
        eq(walletFundingReservation.ownerUserId, input.ownerUserId)
      )
    );
  if (!reservationSnapshot) {
    throw new MoneyDomainError(
      'FUNDING_RESERVATION_NOT_FOUND',
      'Funding Reservation does not exist.'
    );
  }
  const policy = await policyRevisionInTransaction(
    transaction,
    reservationSnapshot.policyRevisionId
  );
  const snapshottedPlatformFeeSatang = calculatePlatformFeeSatang(
    recipientAmountSatang,
    policy.platformFeeBps
  );
  const platformFeeValidation = input.platformFeeValidation ?? 'POLICY';
  if (
    platformFeeValidation === 'QUEST_ESCROW_SNAPSHOT' &&
    reservationSnapshot.callerScope !== 'quest'
  ) {
    throw new MoneyDomainError(
      'PLATFORM_FEE_MISMATCH',
      'Snapshotted Quest Platform Fee allocation requires a Quest Funding Reservation.'
    );
  }
  if (
    platformFeeValidation === 'POLICY' &&
    platformFeeSatang > 0 &&
    platformFeeSatang !== snapshottedPlatformFeeSatang
  ) {
    throw new MoneyDomainError(
      'PLATFORM_FEE_MISMATCH',
      'Platform Fee does not match the Funding Reservation Money Policy.'
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
    platformFeeValidation,
  });
  const { result } = await runMoneyCommand(
    transaction,
    {
      principalUserId: input.ownerUserId,
      scope: operationScope,
      key: input.settlementReference,
      requestHash,
    },
    {
      execute: async (transaction, keyId) => {
        const [reservation] = await transaction
          .select()
          .from(walletFundingReservation)
          .where(
            and(
              eq(walletFundingReservation.id, input.reservationId),
              eq(walletFundingReservation.ownerUserId, input.ownerUserId)
            )
          )
          .for('update');
        if (!reservation) {
          throw new MoneyDomainError(
            'FUNDING_RESERVATION_NOT_FOUND',
            'Funding Reservation does not exist.'
          );
        }
        if (reservation.status !== 'ACTIVE') {
          throw new MoneyDomainError(
            'FUNDING_RESERVATION_NOT_ACTIVE',
            'Funding Reservation is not active.'
          );
        }
        if (reservation.remainingSatang < totalAmountSatang) {
          throw new MoneyDomainError(
            'FUNDING_RESERVATION_INSUFFICIENT',
            'Settlement exceeds remaining reservation funds.'
          );
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
          throw new MoneyDomainError(
            'INVALID_LEDGER_BALANCE',
            'Funding reserved projection is inconsistent.'
          );
        }
        const recipientTotal =
          lockedRecipientWallet.spendingBalanceSatang +
          lockedRecipientWallet.earningsBalanceSatang +
          lockedRecipientWallet.fundingReservedSatang +
          lockedRecipientWallet.reservedForPayoutsSatang;
        if (
          ownerWallet.id !== lockedRecipientWallet.id &&
          recipientTotal + recipientAmountSatang > MAX_WALLET_CAPACITY_SATANG
        ) {
          throw new MoneyDomainError(
            'WALLET_CAPACITY_EXCEEDED',
            'Recipient Wallet capacity would be exceeded.'
          );
        }

        const ownerAccounts = await walletAccountIds(transaction, ownerWallet.id);
        const recipientAccounts =
          ownerWallet.id === lockedRecipientWallet.id
            ? ownerAccounts
            : await walletAccountIds(transaction, lockedRecipientWallet.id);
        const fundingReservedAccountId = ownerAccounts.get('FUNDING_RESERVED');
        const recipientEarningsAccountId = recipientAccounts.get('EARNINGS');
        const [platformRevenueAccount] =
          platformFeeSatang === 0
            ? [undefined]
            : await transaction
                .select({ id: walletLedgerAccount.id })
                .from(walletLedgerAccount)
                .where(eq(walletLedgerAccount.code, 'platform:PLATFORM_REVENUE'));
        if (
          !fundingReservedAccountId ||
          !recipientEarningsAccountId ||
          (platformFeeSatang > 0 && !platformRevenueAccount)
        ) {
          throw new MoneyDomainError(
            'WALLET_ACCOUNT_NOT_FOUND',
            'Required settlement ledger account does not exist.'
          );
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
            idempotencyKeyId: keyId,
            createdByUserId: input.ownerUserId,
            description: 'Settle a Funding Reservation',
          })
          .returning();
        if (!ledgerTransaction) {
          throw new MoneyDomainError(
            'LEDGER_CREATE_FAILED',
            'Ledger transaction could not be created.'
          );
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
            idempotencyKeyId: keyId,
          })
          .returning();
        if (!settlement) {
          throw new MoneyDomainError(
            'FUNDING_SETTLEMENT_FAILED',
            'Funding Reservation settlement could not be created.'
          );
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
            ? [
                {
                  transactionId: ledgerTransaction.id,
                  accountId: platformRevenueAccount.id,
                  amountSatang: platformFeeSatang,
                },
              ]
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
            earningsBalanceSatang:
              lockedRecipientWallet.earningsBalanceSatang + recipientAmountSatang,
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
        await completeMoneyCommand(
          transaction,
          keyId,
          'wallet_funding_reservation_settlement',
          settlement.id
        );

        return { ...settlement, remainingSatang: satang(remainingSatang) };
      },
      replay: async (transaction, keyRow) => {
        if (!keyRow.resourceId) {
          throw new MoneyDomainError(
            'IDEMPOTENCY_UNAVAILABLE',
            'The idempotent settlement record is missing.'
          );
        }
        const [replayed] = await transaction
          .select()
          .from(walletFundingReservationSettlement)
          .where(eq(walletFundingReservationSettlement.id, keyRow.resourceId));
        if (!replayed) {
          throw new MoneyDomainError(
            'IDEMPOTENCY_UNAVAILABLE',
            'The idempotent settlement record is missing.'
          );
        }
        const [settled] = await transaction
          .select({ remainingSatang: walletFundingReservation.remainingSatang })
          .from(walletFundingReservation)
          .where(eq(walletFundingReservation.id, replayed.reservationId));
        if (!settled) {
          throw new MoneyDomainError(
            'IDEMPOTENCY_UNAVAILABLE',
            'The idempotent Funding Reservation is missing.'
          );
        }
        return { ...replayed, remainingSatang: satang(settled.remainingSatang) };
      },
    }
  );
  return result;
};

/**
 * Redirect a Dispute Case amount from the Quest Funding Reservation.
 *
 * A failed Quest keeps its unspent reservation ACTIVE during the dispute
 * window. If the automatic hold release already ran, the same Quest cap is
 * enforced from the settlement history and the transfer uses the Hirer's
 * Spending Balance. Admin code calls this Wallet operation and never writes
 * ledger rows directly.
 */
export const settleDisputeCase = async (
  transaction: WalletTransaction,
  input: SettleDisputeCaseInput
): Promise<SettleDisputeCaseResult> => {
  requireOpaqueReference(input.settlementReference, 'Settlement reference');
  const requestedAmountSatang = positiveSatang(input.requestedAmountSatang);
  const policy = await effectivePolicyInTransaction(transaction);

  const [snapshot] = await transaction
    .select()
    .from(walletFundingReservation)
    .where(
      and(
        eq(walletFundingReservation.id, input.reservationId),
        eq(walletFundingReservation.ownerUserId, input.ownerUserId)
      )
    )
    .limit(1);
  if (!snapshot) {
    throw new MoneyDomainError(
      'FUNDING_RESERVATION_NOT_FOUND',
      'Funding Reservation does not exist.'
    );
  }

  const operationScope = `wallet.dispute-settlement:${input.reservationId}`;
  const requestHash = await sha256Json({
    recipientUserId: input.recipientUserId,
    requestedAmountSatang,
  });
  const { result } = await runMoneyCommand(
    transaction,
    {
      principalUserId: input.ownerUserId,
      scope: operationScope,
      key: input.settlementReference,
      requestHash,
    },
    {
      execute: async (transaction, keyId): Promise<SettleDisputeCaseResult> => {
        const [reservation] = await transaction
          .select()
          .from(walletFundingReservation)
          .where(
            and(
              eq(walletFundingReservation.id, input.reservationId),
              eq(walletFundingReservation.ownerUserId, input.ownerUserId)
            )
          )
          .for('update');
        if (!reservation) {
          throw new MoneyDomainError(
            'FUNDING_RESERVATION_NOT_FOUND',
            'Funding Reservation does not exist.'
          );
        }
        if (reservation.status === 'SETTLED') {
          throw new MoneyDomainError(
            'FUNDING_RESERVATION_NOT_ACTIVE',
            'Funding Reservation state changed before settlement.'
          );
        }

        if (reservation.status === 'ACTIVE') {
          const calculation = calculateDisputeResolutionAmountSatang(
            requestedAmountSatang,
            reservation.remainingSatang,
            policy.maximumFundingReservationSatang
          );
          const recipientAmountSatang = calculation.amountSatang;
          const recipientWallet = await ensureWalletInTransaction(
            transaction,
            input.recipientUserId
          );
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
          if (ownerWallet.fundingReservedSatang < recipientAmountSatang) {
            throw new MoneyDomainError(
              'INVALID_LEDGER_BALANCE',
              'Funding reserved projection is inconsistent.'
            );
          }
          const recipientTotal =
            lockedRecipientWallet.spendingBalanceSatang +
            lockedRecipientWallet.earningsBalanceSatang +
            lockedRecipientWallet.fundingReservedSatang +
            lockedRecipientWallet.reservedForPayoutsSatang;
          if (
            ownerWallet.id !== lockedRecipientWallet.id &&
            recipientTotal + recipientAmountSatang > MAX_WALLET_CAPACITY_SATANG
          ) {
            throw new MoneyDomainError(
              'WALLET_CAPACITY_EXCEEDED',
              'Recipient Wallet capacity would be exceeded.'
            );
          }

          const ownerAccounts = await walletAccountIds(transaction, ownerWallet.id);
          const recipientAccounts =
            ownerWallet.id === lockedRecipientWallet.id
              ? ownerAccounts
              : await walletAccountIds(transaction, lockedRecipientWallet.id);
          const fundingReservedAccountId = ownerAccounts.get('FUNDING_RESERVED');
          const recipientEarningsAccountId = recipientAccounts.get('EARNINGS');
          if (!fundingReservedAccountId || !recipientEarningsAccountId) {
            throw new MoneyDomainError(
              'WALLET_ACCOUNT_NOT_FOUND',
              'Required Dispute settlement ledger account does not exist.'
            );
          }

          const ledgerTransaction = await createSealedLedgerTransactionInTransaction(transaction, {
            businessReference: `dispute-settlement:${await sha256Json({
              reservationId: reservation.id,
              settlementReference: input.settlementReference,
            })}`,
            eventType: 'ADJUSTMENT',
            correctionOfTransactionId: reservation.createdLedgerTransactionId,
            correctionMode: 'ACCOUNT_REDIRECTION',
            idempotencyKeyId: keyId,
            createdByUserId: input.ownerUserId,
            description: 'Redirect Dispute Case funds from an active Funding Reservation',
            postings: [
              {
                accountId: fundingReservedAccountId,
                amountSatang: signedSatang(-recipientAmountSatang),
              },
              {
                accountId: recipientEarningsAccountId,
                amountSatang: signedSatang(recipientAmountSatang),
              },
            ],
          });
          const [settlement] = await transaction
            .insert(walletDisputeSettlement)
            .values({
              reservationId: reservation.id,
              settlementReference: input.settlementReference,
              recipientWalletId: lockedRecipientWallet.id,
              recipientUserId: input.recipientUserId,
              amountSatang: recipientAmountSatang,
              ledgerTransactionId: ledgerTransaction.id,
              idempotencyKeyId: keyId,
            })
            .returning({ id: walletDisputeSettlement.id });
          if (!settlement) {
            throw new MoneyDomainError(
              'FUNDING_SETTLEMENT_FAILED',
              'Dispute Case settlement could not be recorded.'
            );
          }
          const remainingSatang = reservation.remainingSatang - recipientAmountSatang;
          const resultingStatus = remainingSatang === 0 ? 'SETTLED' : 'ACTIVE';
          await transaction
            .update(walletFundingReservation)
            .set({ remainingSatang, status: resultingStatus, updatedAt: new Date() })
            .where(eq(walletFundingReservation.id, reservation.id));
          await completeMoneyCommand(
            transaction,
            keyId,
            'wallet_dispute_settlement',
            settlement.id
          );

          return {
            ledgerTransactionId: ledgerTransaction.id,
            recipientAmountSatang,
            reservationStatus: resultingStatus,
          };
        }

        if (reservation.status !== 'RELEASED') {
          throw new MoneyDomainError(
            'FUNDING_RESERVATION_NOT_ACTIVE',
            'A settled Funding Reservation has no Dispute Case funds remaining.'
          );
        }

        const [fundingSettled] = await transaction
          .select({
            totalAmountSatang: sql<number>`coalesce(sum(${walletFundingReservationSettlement.totalAmountSatang}), 0)`,
          })
          .from(walletFundingReservationSettlement)
          .where(eq(walletFundingReservationSettlement.reservationId, reservation.id));
        const [disputeSettled] = await transaction
          .select({
            amountSatang: sql<number>`coalesce(sum(${walletDisputeSettlement.amountSatang}), 0)`,
          })
          .from(walletDisputeSettlement)
          .where(eq(walletDisputeSettlement.reservationId, reservation.id));
        const alreadySettledSatang =
          Number(fundingSettled?.totalAmountSatang ?? 0) +
          Number(disputeSettled?.amountSatang ?? 0);
        const availableSatang = reservation.totalReservedSatang - alreadySettledSatang;
        const calculation = calculateDisputeResolutionAmountSatang(
          requestedAmountSatang,
          availableSatang,
          policy.maximumFundingReservationSatang
        );
        const recipientAmountSatang = calculation.amountSatang;

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
        if (ownerWallet.spendingBalanceSatang < recipientAmountSatang) {
          throw new MoneyDomainError(
            'INSUFFICIENT_SPENDING_BALANCE',
            'Hirer Spending Balance is insufficient.'
          );
        }
        const recipientTotal =
          lockedRecipientWallet.spendingBalanceSatang +
          lockedRecipientWallet.earningsBalanceSatang +
          lockedRecipientWallet.fundingReservedSatang +
          lockedRecipientWallet.reservedForPayoutsSatang;
        if (
          ownerWallet.id !== lockedRecipientWallet.id &&
          recipientTotal + recipientAmountSatang > MAX_WALLET_CAPACITY_SATANG
        ) {
          throw new MoneyDomainError(
            'WALLET_CAPACITY_EXCEEDED',
            'Recipient Wallet capacity would be exceeded.'
          );
        }

        const ownerAccounts = await walletAccountIds(transaction, ownerWallet.id);
        const recipientAccounts =
          ownerWallet.id === lockedRecipientWallet.id
            ? ownerAccounts
            : await walletAccountIds(transaction, lockedRecipientWallet.id);
        const spendingAccountId = ownerAccounts.get('SPENDING');
        const recipientEarningsAccountId = recipientAccounts.get('EARNINGS');
        if (!spendingAccountId || !recipientEarningsAccountId) {
          throw new MoneyDomainError(
            'WALLET_ACCOUNT_NOT_FOUND',
            'Required Dispute settlement ledger account does not exist.'
          );
        }

        const [releaseOperation] = await transaction
          .select({ ledgerTransactionId: walletFundingReservationOperation.ledgerTransactionId })
          .from(walletFundingReservationOperation)
          .where(
            and(
              eq(walletFundingReservationOperation.reservationId, reservation.id),
              eq(walletFundingReservationOperation.operationType, 'RELEASE')
            )
          )
          .orderBy(desc(walletFundingReservationOperation.createdAt))
          .limit(1);
        if (!releaseOperation) {
          throw new MoneyDomainError(
            'FUNDING_SETTLEMENT_FAILED',
            'The released Funding Reservation has no release Ledger Transaction.'
          );
        }

        const ledgerTransaction = await createSealedLedgerTransactionInTransaction(transaction, {
          businessReference: `dispute-settlement:${await sha256Json({
            reservationId: reservation.id,
            settlementReference: input.settlementReference,
          })}`,
          eventType: 'ADJUSTMENT',
          correctionOfTransactionId: releaseOperation.ledgerTransactionId,
          correctionMode: 'ACCOUNT_REDIRECTION',
          idempotencyKeyId: keyId,
          createdByUserId: input.ownerUserId,
          description: 'Redirect Dispute Case funds after Funding Reservation release',
          postings: [
            { accountId: spendingAccountId, amountSatang: signedSatang(-recipientAmountSatang) },
            {
              accountId: recipientEarningsAccountId,
              amountSatang: signedSatang(recipientAmountSatang),
            },
          ],
        });
        const [settlement] = await transaction
          .insert(walletDisputeSettlement)
          .values({
            reservationId: reservation.id,
            settlementReference: input.settlementReference,
            recipientWalletId: lockedRecipientWallet.id,
            recipientUserId: input.recipientUserId,
            amountSatang: recipientAmountSatang,
            ledgerTransactionId: ledgerTransaction.id,
            idempotencyKeyId: keyId,
          })
          .returning({ id: walletDisputeSettlement.id });
        if (!settlement) {
          throw new MoneyDomainError(
            'FUNDING_SETTLEMENT_FAILED',
            'Dispute Case settlement could not be recorded.'
          );
        }
        await completeMoneyCommand(transaction, keyId, 'wallet_dispute_settlement', settlement.id);

        return {
          ledgerTransactionId: ledgerTransaction.id,
          recipientAmountSatang,
          reservationStatus: reservation.status,
        };
      },
      replay: async (transaction, keyRow) => {
        if (!keyRow.resourceId) {
          throw new MoneyDomainError(
            'IDEMPOTENCY_UNAVAILABLE',
            'The idempotent Dispute settlement is missing.'
          );
        }
        const [settlement] = await transaction
          .select({
            ledgerTransactionId: walletDisputeSettlement.ledgerTransactionId,
            amountSatang: walletDisputeSettlement.amountSatang,
          })
          .from(walletDisputeSettlement)
          .where(eq(walletDisputeSettlement.id, keyRow.resourceId));
        const [reservation] = await transaction
          .select({ status: walletFundingReservation.status })
          .from(walletFundingReservation)
          .where(eq(walletFundingReservation.id, input.reservationId));
        if (!settlement || !reservation) {
          throw new MoneyDomainError(
            'IDEMPOTENCY_UNAVAILABLE',
            'The idempotent Dispute settlement is missing.'
          );
        }
        return {
          ledgerTransactionId: settlement.ledgerTransactionId,
          recipientAmountSatang: satang(settlement.amountSatang),
          reservationStatus: reservation.status,
        };
      },
    }
  );
  return result;
};

export const readFundingReservation = async (
  transaction: WalletTransaction,
  input: ReadFundingReservationInput
): Promise<
  | {
      reservationId: string;
      status: FundingReservationStatus;
      remainingSatang: Satang;
    }
  | undefined
> => {
  const [reservation] = await transaction
    .select({
      reservationId: walletFundingReservation.id,
      status: walletFundingReservation.status,
      remainingSatang: walletFundingReservation.remainingSatang,
    })
    .from(walletFundingReservation)
    .where(
      and(
        eq(walletFundingReservation.ownerUserId, input.ownerUserId),
        eq(walletFundingReservation.callerScope, input.callerScope),
        eq(walletFundingReservation.callerReference, input.callerReference)
      )
    )
    .limit(1);
  if (!reservation) return undefined;
  return { ...reservation, remainingSatang: satang(reservation.remainingSatang) };
};

export const fundingCapacityFor = async (
  transaction: WalletTransaction,
  input: FundingCapacityInput
): Promise<{
  canReserve: boolean;
  spendingBalanceSatang: Satang;
  reason?: 'WALLET_NOT_FOUND' | 'WALLET_NOT_ACTIVE' | 'INSUFFICIENT_SPENDING_BALANCE';
}> => {
  const [wallet] = await transaction
    .select({
      spendingBalanceSatang: walletWallet.spendingBalanceSatang,
      walletStatus: walletWallet.walletStatus,
    })
    .from(walletWallet)
    .where(eq(walletWallet.userId, input.ownerUserId));
  if (!wallet) {
    return { canReserve: false, spendingBalanceSatang: satang(0), reason: 'WALLET_NOT_FOUND' };
  }
  if (!isWalletOperationAllowed(wallet.walletStatus, 'FUNDING_RESERVATION')) {
    return {
      canReserve: false,
      spendingBalanceSatang: satang(wallet.spendingBalanceSatang),
      reason: 'WALLET_NOT_ACTIVE',
    };
  }
  if (wallet.spendingBalanceSatang < input.requiredSatang) {
    return {
      canReserve: false,
      spendingBalanceSatang: satang(wallet.spendingBalanceSatang),
      reason: 'INSUFFICIENT_SPENDING_BALANCE',
    };
  }
  return { canReserve: true, spendingBalanceSatang: satang(wallet.spendingBalanceSatang) };
};

export const platformFeeForReservation = async (
  transaction: WalletTransaction,
  input: PlatformFeeForReservationInput
): Promise<Satang> => {
  const [reservation] = await transaction
    .select({ policyRevisionId: walletFundingReservation.policyRevisionId })
    .from(walletFundingReservation)
    .where(eq(walletFundingReservation.id, input.reservationId))
    .limit(1);
  if (!reservation) {
    throw new MoneyDomainError(
      'FUNDING_RESERVATION_NOT_FOUND',
      'Funding Reservation does not exist.'
    );
  }
  const policy = await policyRevisionInTransaction(transaction, reservation.policyRevisionId);
  return calculatePlatformFeeSatang(satang(input.rewardSatang), policy.platformFeeBps);
};
