/**
 * The test seam for Quest money outcomes.
 *
 * ADR-0030 keeps Quest a composer of Wallet verbs. These fixtures keep the same
 * rule for the tests: a Quest test asserts a money outcome through this module,
 * so no Quest test imports the Wallet schema and no Quest test pins a
 * Wallet-internal storage shape.
 */
import { db } from '@/database/client';
import {
  walletDisputeSettlement,
  walletFundingReservation,
  walletFundingReservationOperation,
  walletFundingReservationSettlement,
  walletIdempotencyKey,
  walletLedgerAccount,
  walletLedgerPosting,
  walletLedgerTransaction,
  walletWallet,
  type FundingReservationStatus,
  type WalletStatus,
} from '@/database/schema/wallet.schema';
import {
  changeWalletStatusInTransaction,
  createSealedLedgerTransaction,
  ensureInitialMoneyPolicy,
  ensureWallet,
  releaseFundingReservation,
  signedSatang,
} from '@/modules/wallet';

import { randomUUID } from 'node:crypto';

import { and, asc, eq, inArray } from 'drizzle-orm';

/** Quest holds its Escrow under one caller scope. See `quest-escrow.service.ts`. */
const questCallerScope = 'quest';

const platformSuspenseCode = 'platform:PLATFORM_SUSPENSE';

/**
 * Credits a Spending Balance from the Platform Suspense account, as a Top-up
 * does. It provisions the Wallet and the initial Money Policy, so a test can
 * fund a Hirer in one call.
 */
export const fundTestWallet = async (userId: string, amountSatang: number) => {
  await ensureInitialMoneyPolicy();
  const wallet = await ensureWallet(userId);
  const [spending] = await db
    .select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(
      and(eq(walletLedgerAccount.walletId, wallet.id), eq(walletLedgerAccount.type, 'SPENDING'))
    );
  const [suspense] = await db
    .select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(eq(walletLedgerAccount.code, platformSuspenseCode));
  if (!spending || !suspense) {
    throw new Error(`Wallet ledger accounts are not provisioned for user ${userId}.`);
  }

  await createSealedLedgerTransaction({
    businessReference: `wallet-test-fixture-top-up-${randomUUID()}`,
    eventType: 'TOP_UP',
    postings: [
      { accountId: spending.id, amountSatang: signedSatang(amountSatang) },
      { accountId: suspense.id, amountSatang: signedSatang(-amountSatang) },
    ],
  });
};

/**
 * Sets the Wallet Status through the Wallet verb, with the Wallet owner as the
 * audited actor. The call does nothing when the Wallet already has the status,
 * so a test can reset a Wallet to `ACTIVE` without a status check.
 *
 * `CLOSED` is terminal for the verb (`wallet.status.service.ts:95-97`), so a
 * reset from `CLOSED` writes the column and no history row. Teardown is not a
 * domain action, and a test that asserts the terminal rule calls the verb.
 */
export const setTestWalletStatus = async (userId: string, toStatus: WalletStatus) => {
  const wallet = await ensureWallet(userId);
  if (wallet.walletStatus === toStatus) return;

  if (wallet.walletStatus === 'CLOSED') {
    await db
      .update(walletWallet)
      .set({ walletStatus: toStatus, updatedAt: new Date() })
      .where(eq(walletWallet.id, wallet.id));
    return;
  }

  await db.transaction((transaction) =>
    changeWalletStatusInTransaction(transaction, {
      walletId: wallet.id,
      toStatus,
      reason: 'Test fixture set the Wallet Status.',
      actorUserId: userId,
    })
  );
};

/**
 * Reads the balances and the status of one Wallet.
 *
 * The Wallet verb `getWallet` brands each balance as `Satang`, which a test
 * cannot compare with a plain arithmetic expectation, so the seam reads the
 * columns. It throws when the Wallet is absent, as the verb does.
 */
export const readTestWallet = async (userId: string) => {
  const [wallet] = await db
    .select({
      id: walletWallet.id,
      spendingBalanceSatang: walletWallet.spendingBalanceSatang,
      earningsBalanceSatang: walletWallet.earningsBalanceSatang,
      fundingReservedSatang: walletWallet.fundingReservedSatang,
      reservedForPayoutsSatang: walletWallet.reservedForPayoutsSatang,
      walletStatus: walletWallet.walletStatus,
      updatedAt: walletWallet.updatedAt,
    })
    .from(walletWallet)
    .where(eq(walletWallet.userId, userId));
  if (!wallet) throw new Error(`Wallet does not exist for user ${userId}.`);
  return wallet;
};

export type TestQuestEscrow = {
  id: string;
  ownerUserId: string;
  questId: string;
  policyRevisionId: string;
  totalReservedSatang: number;
  remainingSatang: number;
  status: FundingReservationStatus;
  createdLedgerTransactionId: string;
};

const questEscrowColumns = {
  id: walletFundingReservation.id,
  ownerUserId: walletFundingReservation.ownerUserId,
  questId: walletFundingReservation.callerReference,
  policyRevisionId: walletFundingReservation.policyRevisionId,
  totalReservedSatang: walletFundingReservation.totalReservedSatang,
  remainingSatang: walletFundingReservation.remainingSatang,
  status: walletFundingReservation.status,
  createdLedgerTransactionId: walletFundingReservation.createdLedgerTransactionId,
};

/** Reads the Quest Escrow of one Quest, or `undefined` when the Quest holds none. */
export const readTestQuestEscrow = async (input: {
  ownerUserId: string;
  questId: string;
}): Promise<TestQuestEscrow | undefined> => {
  const [escrow] = await db
    .select(questEscrowColumns)
    .from(walletFundingReservation)
    .where(
      and(
        eq(walletFundingReservation.ownerUserId, input.ownerUserId),
        eq(walletFundingReservation.callerScope, questCallerScope),
        eq(walletFundingReservation.callerReference, input.questId)
      )
    );
  return escrow;
};

/**
 * Lists the Quest Escrows of one or more Hirers. A test counts the rows to
 * assert that publish made exactly one Escrow, or that a rollback left none.
 */
export const listTestQuestEscrows = async (input: {
  ownerUserIds: string[];
  questIds?: string[];
  status?: FundingReservationStatus;
}): Promise<TestQuestEscrow[]> => {
  if (input.ownerUserIds.length === 0) return [];

  return db
    .select(questEscrowColumns)
    .from(walletFundingReservation)
    .where(
      and(
        inArray(walletFundingReservation.ownerUserId, input.ownerUserIds),
        eq(walletFundingReservation.callerScope, questCallerScope),
        input.questIds
          ? inArray(walletFundingReservation.callerReference, input.questIds)
          : undefined,
        input.status ? eq(walletFundingReservation.status, input.status) : undefined
      )
    );
};

export type TestQuestEscrowSettlement = {
  recipientUserId: string;
  recipientAmountSatang: number;
  platformFeeSatang: number;
  totalAmountSatang: number;
  ledgerTransactionId: string;
};

/** Lists what each Worker received from one Quest Escrow. */
export const listTestQuestEscrowSettlements = async (
  reservationId: string
): Promise<TestQuestEscrowSettlement[]> =>
  db
    .select({
      recipientUserId: walletFundingReservationSettlement.recipientUserId,
      recipientAmountSatang: walletFundingReservationSettlement.recipientAmountSatang,
      platformFeeSatang: walletFundingReservationSettlement.platformFeeSatang,
      totalAmountSatang: walletFundingReservationSettlement.totalAmountSatang,
      ledgerTransactionId: walletFundingReservationSettlement.ledgerTransactionId,
    })
    .from(walletFundingReservationSettlement)
    .where(eq(walletFundingReservationSettlement.reservationId, reservationId));

/** Lists the reserve, increase, and release operations of one Quest Escrow. */
export const listTestQuestEscrowOperations = async (reservationId: string) =>
  db
    .select({
      operationType: walletFundingReservationOperation.operationType,
      operationReference: walletFundingReservationOperation.operationReference,
      amountSatang: walletFundingReservationOperation.amountSatang,
      resultingRemainingSatang: walletFundingReservationOperation.resultingRemainingSatang,
      resultingStatus: walletFundingReservationOperation.resultingStatus,
      ledgerTransactionId: walletFundingReservationOperation.ledgerTransactionId,
    })
    .from(walletFundingReservationOperation)
    .where(eq(walletFundingReservationOperation.reservationId, reservationId));

/** Lists the Dispute transfers that an Admin settled from one Quest Escrow. */
export const listTestDisputeSettlements = async (reservationId: string) =>
  db
    .select({
      settlementReference: walletDisputeSettlement.settlementReference,
      recipientUserId: walletDisputeSettlement.recipientUserId,
      amountSatang: walletDisputeSettlement.amountSatang,
      ledgerTransactionId: walletDisputeSettlement.ledgerTransactionId,
    })
    .from(walletDisputeSettlement)
    .where(eq(walletDisputeSettlement.reservationId, reservationId));

/** Reads the Ledger Transactions that a money outcome named. */
export const listTestLedgerTransactions = async (transactionIds: string[]) => {
  if (transactionIds.length === 0) return [];

  return db
    .select({
      id: walletLedgerTransaction.id,
      eventType: walletLedgerTransaction.eventType,
      sealedAt: walletLedgerTransaction.sealedAt,
      correctionOfTransactionId: walletLedgerTransaction.correctionOfTransactionId,
    })
    .from(walletLedgerTransaction)
    .where(inArray(walletLedgerTransaction.id, transactionIds));
};

/**
 * Lists every Ledger Transaction that touched a Wallet account of one owner.
 * A test snapshots this before and after a read-only route, to prove that the
 * route wrote no Ledger Transaction, even a balance-neutral one.
 */
export const listTestWalletLedgerTransactions = async (userId: string) =>
  db
    .selectDistinct({
      id: walletLedgerTransaction.id,
      eventType: walletLedgerTransaction.eventType,
    })
    .from(walletLedgerTransaction)
    .innerJoin(
      walletLedgerPosting,
      eq(walletLedgerPosting.transactionId, walletLedgerTransaction.id)
    )
    .innerJoin(walletLedgerAccount, eq(walletLedgerAccount.id, walletLedgerPosting.accountId))
    .innerJoin(walletWallet, eq(walletWallet.id, walletLedgerAccount.walletId))
    .where(eq(walletWallet.userId, userId))
    .orderBy(asc(walletLedgerTransaction.id));

/**
 * Reads the Ledger Postings of the named Ledger Transactions, with the account
 * type, the account code, and the Wallet owner of each posting. A test asserts
 * where the money went without a separate Ledger Account lookup.
 */
export const listTestLedgerPostings = async (transactionIds: string[]) => {
  if (transactionIds.length === 0) return [];

  return db
    .select({
      transactionId: walletLedgerPosting.transactionId,
      accountType: walletLedgerAccount.type,
      accountCode: walletLedgerAccount.code,
      ownerUserId: walletWallet.userId,
      amountSatang: walletLedgerPosting.amountSatang,
    })
    .from(walletLedgerPosting)
    .innerJoin(walletLedgerAccount, eq(walletLedgerAccount.id, walletLedgerPosting.accountId))
    .leftJoin(walletWallet, eq(walletWallet.id, walletLedgerAccount.walletId))
    .where(inArray(walletLedgerPosting.transactionId, transactionIds));
};

/**
 * Releases every active Quest Escrow of the named Hirers through the Wallet
 * verb. A Funding Reservation and its Ledger rows are immutable audit facts, so
 * teardown releases a live hold instead of deleting the row.
 */
export const releaseTestQuestEscrows = async (ownerUserIds: string[]) => {
  const active = await listTestQuestEscrows({ ownerUserIds, status: 'ACTIVE' });
  for (const escrow of active) {
    await db.transaction((transaction) =>
      releaseFundingReservation(transaction, {
        ownerUserId: escrow.ownerUserId,
        reservationId: escrow.id,
        operationReference: `wallet-test-fixture-release-${randomUUID()}`,
      })
    );
  }
};

/** Deletes the Idempotency Keys of the named principals, for test teardown. */
export const deleteTestIdempotencyKeys = async (input: {
  principalUserIds: string[];
  operationScope?: string;
}) => {
  if (input.principalUserIds.length === 0) return;

  await db
    .delete(walletIdempotencyKey)
    .where(
      and(
        inArray(walletIdempotencyKey.principalUserId, input.principalUserIds),
        input.operationScope
          ? eq(walletIdempotencyKey.operationScope, input.operationScope)
          : undefined
      )
    );
};
