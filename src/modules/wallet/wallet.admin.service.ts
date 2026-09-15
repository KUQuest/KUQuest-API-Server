import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { walletWallet, type WalletStatus } from '@/database/schema/wallet.schema';
import {
  createAdminActionService,
  type AdminActionReasonCatalog,
  type AdminActionResult,
} from '@/modules/admin';
import { CursorInputError, decodeCursor, encodeCursor, parsePageLimit } from '@/shared/cursor';
import { readKeysetPage } from '@/shared/keyset-page';

import { and, eq, ilike, or } from 'drizzle-orm';

import { MoneyDomainError } from './wallet.money';
import { walletProjectionMatchesLedger } from './wallet.service';
import { changeWalletStatusInTransaction } from './wallet.status.service';
import type {
  AdminWalletFullDetailResponse,
  AdminWalletListItem,
  AdminWalletListQuery,
} from './wallet.admin.schema';

export type AdminWalletListPage = {
  items: AdminWalletListItem[];
  nextCursor: string | null;
};

export const listAdminWallets = async (
  query: AdminWalletListQuery = {}
): Promise<AdminWalletListPage> => {
  const limit = parsePageLimit(query.limit);
  const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;

  const page = await readKeysetPage({
    anchor: { time: walletWallet.createdAt, id: walletWallet.id },
    cursor,
    limit,
    where: and(
      query.status ? eq(walletWallet.walletStatus, query.status) : undefined,
      query.userId ? eq(walletWallet.userId, query.userId) : undefined,
      query.search
        ? or(
            ilike(authUser.firstName, `%${query.search}%`),
            ilike(authUser.lastName, `%${query.search}%`),
            ilike(authUser.studentId, `%${query.search}%`),
            ilike(authUser.email, `%${query.search}%`)
          )
        : undefined
    ),
    read: ({ where, orderBy, limit: probe }) =>
      db
        .select({
          id: walletWallet.id,
          userId: walletWallet.userId,
          walletStatus: walletWallet.walletStatus,
          spendingBalanceSatang: walletWallet.spendingBalanceSatang,
          earningsBalanceSatang: walletWallet.earningsBalanceSatang,
          fundingReservedSatang: walletWallet.fundingReservedSatang,
          reservedForPayoutsSatang: walletWallet.reservedForPayoutsSatang,
          createdAt: walletWallet.createdAt,
          updatedAt: walletWallet.updatedAt,
          firstName: authUser.firstName,
          lastName: authUser.lastName,
          studentId: authUser.studentId,
          email: authUser.email,
          telephone: authUser.telephone,
        })
        .from(walletWallet)
        .innerJoin(authUser, eq(walletWallet.userId, authUser.id))
        .where(where)
        .orderBy(...orderBy)
        .limit(probe),
    rowCursor: (row) => ({ startTime: row.createdAt, id: row.id }),
    invalidCursor: () => new CursorInputError('INVALID_CURSOR', 'cursor does not match a Wallet'),
  });

  const nextCursor = page.nextCursor ? encodeCursor(page.nextCursor) : null;

  const items: AdminWalletListItem[] = page.rows.map((r) => {
    const totalBalanceSatang =
      r.spendingBalanceSatang +
      r.earningsBalanceSatang +
      r.fundingReservedSatang +
      r.reservedForPayoutsSatang;

    return {
      id: r.id,
      userId: r.userId,
      member: {
        firstName: r.firstName,
        lastName: r.lastName,
        studentId: r.studentId,
        email: r.email,
        telephone: r.telephone,
      },
      walletStatus: r.walletStatus,
      balances: {
        spendingBalanceSatang: r.spendingBalanceSatang,
        earningsBalanceSatang: r.earningsBalanceSatang,
        fundingReservedSatang: r.fundingReservedSatang,
        reservedForPayoutsSatang: r.reservedForPayoutsSatang,
        totalBalanceSatang,
      },
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  });

  return {
    items,
    nextCursor,
  };
};

export const getAdminWalletDetail = async (
  walletId: string
): Promise<AdminWalletFullDetailResponse['data']['wallet'] | null> => {
  const [row] = await db
    .select({
      id: walletWallet.id,
      userId: walletWallet.userId,
      walletStatus: walletWallet.walletStatus,
      spendingBalanceSatang: walletWallet.spendingBalanceSatang,
      earningsBalanceSatang: walletWallet.earningsBalanceSatang,
      fundingReservedSatang: walletWallet.fundingReservedSatang,
      reservedForPayoutsSatang: walletWallet.reservedForPayoutsSatang,
      createdAt: walletWallet.createdAt,
      updatedAt: walletWallet.updatedAt,
      firstName: authUser.firstName,
      lastName: authUser.lastName,
      studentId: authUser.studentId,
      email: authUser.email,
      telephone: authUser.telephone,
    })
    .from(walletWallet)
    .innerJoin(authUser, eq(walletWallet.userId, authUser.id))
    .where(eq(walletWallet.id, walletId));

  if (!row) {
    return null;
  }

  // Check projection reconciliation against ledger accounts
  const matches = await walletProjectionMatchesLedger(walletId, {
    spendingBalanceSatang: row.spendingBalanceSatang,
    earningsBalanceSatang: row.earningsBalanceSatang,
    fundingReservedSatang: row.fundingReservedSatang,
    reservedForPayoutsSatang: row.reservedForPayoutsSatang,
  });

  const totalBalanceSatang =
    row.spendingBalanceSatang +
    row.earningsBalanceSatang +
    row.fundingReservedSatang +
    row.reservedForPayoutsSatang;

  return {
    id: row.id,
    userId: row.userId,
    member: {
      firstName: row.firstName,
      lastName: row.lastName,
      studentId: row.studentId,
      email: row.email,
      telephone: row.telephone,
    },
    walletStatus: row.walletStatus,
    balances: {
      spendingBalanceSatang: row.spendingBalanceSatang,
      earningsBalanceSatang: row.earningsBalanceSatang,
      fundingReservedSatang: row.fundingReservedSatang,
      reservedForPayoutsSatang: row.reservedForPayoutsSatang,
      totalBalanceSatang,
    },
    projectionMatchesLedger: matches,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
};

export type WalletBalances = {
  spendingBalanceSatang: number;
  earningsBalanceSatang: number;
  fundingReservedSatang: number;
  reservedForPayoutsSatang: number;
  walletStatus?: string;
};

export type SerializedWallet = WalletBalances & { walletStatus: string };

export const serializeWallet = (
  wallet: WalletBalances | { wallet: WalletBalances }
): SerializedWallet => {
  const target = 'wallet' in wallet && wallet.wallet ? wallet.wallet : (wallet as WalletBalances);
  return {
    spendingBalanceSatang: target.spendingBalanceSatang,
    earningsBalanceSatang: target.earningsBalanceSatang,
    fundingReservedSatang: target.fundingReservedSatang,
    reservedForPayoutsSatang: target.reservedForPayoutsSatang,
    walletStatus: 'walletStatus' in target ? String(target.walletStatus) : 'ACTIVE',
  };
};

export const walletAdminActionCatalog: AdminActionReasonCatalog = {
  version: 1,
  actions: {
    WALLET_FREEZE: { kind: 'COMMAND', requiresReason: false, allowedReasonCodes: [] },
    WALLET_UNFREEZE: { kind: 'COMMAND', requiresReason: false, allowedReasonCodes: [] },
    WALLET_SUSPEND: { kind: 'COMMAND', requiresReason: false, allowedReasonCodes: [] },
    WALLET_CLOSE: { kind: 'COMMAND', requiresReason: false, allowedReasonCodes: [] },
  },
};

const walletAdminActionService = createAdminActionService(walletAdminActionCatalog);

const walletStatusActions: Record<WalletStatus, string> = {
  ACTIVE: 'WALLET_UNFREEZE',
  FROZEN: 'WALLET_FREEZE',
  SUSPENDED: 'WALLET_SUSPEND',
  CLOSED: 'WALLET_CLOSE',
};

export const actionForWalletStatus = (toStatus: WalletStatus): string =>
  walletStatusActions[toStatus];

export type ChangeWalletStatusAdminInput = {
  adminId: string;
  walletId: string;
  toStatus: WalletStatus;
  reason: string;
  requestKey: string;
};

export const changeWalletStatusAdmin = async (
  input: ChangeWalletStatusAdminInput
): Promise<AdminActionResult<{ wallet: SerializedWallet }>> => {
  const action = actionForWalletStatus(input.toStatus);
  return walletAdminActionService.executeCommand<{ wallet: SerializedWallet }>({
    adminId: input.adminId,
    action,
    resourceType: 'wallet',
    resourceId: input.walletId,
    requestKey: input.requestKey,
    expectedVersion: 1,
    request: {
      toStatus: input.toStatus,
      reason: input.reason,
    },
    metadata: {},
    prepare: async (transaction) => {
      const [current] = await transaction
        .select({
          id: walletWallet.id,
          walletStatus: walletWallet.walletStatus,
          updatedAt: walletWallet.updatedAt,
        })
        .from(walletWallet)
        .where(eq(walletWallet.id, input.walletId))
        .limit(1)
        .for('update');
      if (!current) throw new MoneyDomainError('WALLET_NOT_FOUND', 'Wallet does not exist.');
      if (current.walletStatus === input.toStatus) {
        throw new MoneyDomainError('WALLET_STATUS_UNCHANGED', 'Wallet already has this status.');
      }
      if (current.walletStatus === 'CLOSED') {
        throw new MoneyDomainError('WALLET_STATUS_CLOSED', 'Closed Wallet status is terminal.');
      }

      return {
        currentVersion: 1,
        apply: async () => {
          const { wallet: updated } = await changeWalletStatusInTransaction(transaction, {
            walletId: input.walletId,
            toStatus: input.toStatus,
            reason: input.reason,
            actorAdminId: input.adminId,
          });

          return {
            resourceSummary: { wallet: serializeWallet(updated) },
            resourceVersion: 2,
            resourceTimestamp: null,
          };
        },
      };
    },
  });
};
