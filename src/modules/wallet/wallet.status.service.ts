import { db } from '@/database/client';
import {
  type WalletStatus,
  walletStatusHistory,
  walletStatuses,
  walletWallet,
} from '@/database/schema/wallet.schema';

import { asc, eq, sql } from 'drizzle-orm';

import { MoneyDomainError } from './wallet.money';
import type { WalletTransaction } from './wallet.service';

export const walletOperations = [
  'TOP_UP',
  'EARNINGS_CONVERSION',
  'FUNDING_RESERVATION',
  'PAYOUT',
  'CONFIRMED_INBOUND_CREDIT',
  'EARNINGS_SETTLEMENT',
  'FUNDING_RELEASE',
  'PAYOUT_FAILURE_RELEASE',
  'PROVIDER_PROCESSING',
  'RECONCILIATION',
] as const;
export type WalletOperation = (typeof walletOperations)[number];

const studentInitiatedOperations = new Set<WalletOperation>([
  'TOP_UP',
  'EARNINGS_CONVERSION',
  'FUNDING_RESERVATION',
  'PAYOUT',
]);

type WalletStatusActor =
  | { actorUserId: string; actorAdminId?: never; actorSystem?: never }
  | { actorAdminId: string; actorUserId?: never; actorSystem?: never }
  | { actorSystem: true; actorUserId?: never; actorAdminId?: never };

export type ChangeWalletStatusInput = {
  walletId: string;
  toStatus: WalletStatus;
  reason: string;
} & WalletStatusActor;

export const isWalletOperationAllowed = (
  walletStatus: WalletStatus,
  operation: WalletOperation
): boolean => walletStatus === 'ACTIVE' || !studentInitiatedOperations.has(operation);

export const assertWalletOperationAllowed = (
  walletStatus: WalletStatus,
  operation: WalletOperation
) => {
  if (isWalletOperationAllowed(walletStatus, operation)) return;

  throw new MoneyDomainError(
    'WALLET_NOT_ACTIVE',
    `Wallet status ${walletStatus} does not permit ${operation}.`
  );
};

const validateStatusChangeInput = (input: ChangeWalletStatusInput) => {
  if (!(walletStatuses as readonly string[]).includes(input.toStatus)) {
    throw new MoneyDomainError('INVALID_WALLET_STATUS', 'Wallet status is not supported.');
  }
  if (input.reason.trim().length === 0) {
    throw new MoneyDomainError(
      'WALLET_STATUS_REASON_REQUIRED',
      'Wallet status change reason is required.'
    );
  }

  const actors = [input.actorUserId, input.actorAdminId].filter(Boolean);
  const hasValidActor = input.actorSystem ? actors.length === 0 : actors.length === 1;
  if (!hasValidActor) {
    throw new MoneyDomainError(
      'INVALID_WALLET_STATUS_ACTOR',
      'Exactly one Wallet status actor or the system origin is required.'
    );
  }
};

export const changeWalletStatusInTransaction = async (
  transaction: WalletTransaction,
  input: ChangeWalletStatusInput
) => {
  validateStatusChangeInput(input);

  const [wallet] = await transaction
    .select()
    .from(walletWallet)
    .where(eq(walletWallet.id, input.walletId))
    .for('update');
  if (!wallet) throw new MoneyDomainError('WALLET_NOT_FOUND', 'Wallet does not exist.');
  if (wallet.walletStatus === input.toStatus) {
    throw new MoneyDomainError('WALLET_STATUS_UNCHANGED', 'Wallet already has this status.');
  }
  if (wallet.walletStatus === 'CLOSED') {
    throw new MoneyDomainError('WALLET_STATUS_CLOSED', 'Closed Wallet status is terminal.');
  }

  const [history] = await transaction
    .insert(walletStatusHistory)
    .values({
      walletId: wallet.id,
      fromStatus: wallet.walletStatus,
      toStatus: input.toStatus,
      actorUserId: input.actorUserId,
      actorAdminId: input.actorAdminId,
      reason: input.reason,
      occurredAt: sql`clock_timestamp()`,
    })
    .returning();
  if (!history) {
    throw new MoneyDomainError(
      'WALLET_STATUS_CHANGE_FAILED',
      'Wallet status history could not be recorded.'
    );
  }

  const [updatedWallet] = await transaction
    .update(walletWallet)
    .set({ walletStatus: input.toStatus, updatedAt: new Date() })
    .where(eq(walletWallet.id, wallet.id))
    .returning();
  if (!updatedWallet) {
    throw new MoneyDomainError(
      'WALLET_STATUS_CHANGE_FAILED',
      'Wallet status could not be changed.'
    );
  }

  return { wallet: updatedWallet, history };
};

export const changeWalletStatus = async (input: ChangeWalletStatusInput) =>
  db.transaction((transaction) => changeWalletStatusInTransaction(transaction, input));

export const listWalletStatusHistory = async (walletId: string) =>
  db
    .select()
    .from(walletStatusHistory)
    .where(eq(walletStatusHistory.walletId, walletId))
    .orderBy(asc(walletStatusHistory.occurredAt), asc(walletStatusHistory.id));
