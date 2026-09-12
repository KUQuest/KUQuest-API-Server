import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import {
  walletLedgerAccount,
  walletLedgerPosting,
  walletWallet,
} from '@/database/schema/wallet.schema';
import { decodeCursor, encodeCursor } from '@/shared/cursor';

import { and, desc, eq, ilike, lt, or, sql } from 'drizzle-orm';

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
  query: AdminWalletListQuery = {},
): Promise<AdminWalletListPage> => {
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
  const conditions = [];

  if (query.status) {
    conditions.push(eq(walletWallet.walletStatus, query.status));
  }
  if (query.userId) {
    conditions.push(eq(walletWallet.userId, query.userId));
  }
  if (query.search) {
    const s = `%${query.search}%`;
    conditions.push(
      or(
        ilike(authUser.firstName, s),
        ilike(authUser.lastName, s),
        ilike(authUser.studentId, s),
        ilike(authUser.email, s),
      ),
    );
  }

  if (query.cursor) {
    const parsed = decodeCursor(query.cursor);
    if (parsed) {
      const cursorDate = new Date(parsed.startTime);
      conditions.push(
        or(
          lt(walletWallet.createdAt, cursorDate),
          and(
            eq(walletWallet.createdAt, cursorDate),
            lt(walletWallet.id, parsed.id),
          ),
        ),
      );
    }
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
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
    .where(whereClause)
    .orderBy(desc(walletWallet.createdAt), desc(walletWallet.id))
    .limit(limit + 1);

  const hasNextPage = rows.length > limit;
  const pageRows = hasNextPage ? rows.slice(0, limit) : rows;

  let nextCursor: string | null = null;
  if (hasNextPage && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1];
    nextCursor = encodeCursor({
      id: last.id,
      startTime: last.createdAt.toISOString(),
    });
  }

  const items: AdminWalletListItem[] = pageRows.map((r) => {
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
  walletId: string,
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
  const accountRows = await db
    .select({
      type: walletLedgerAccount.type,
      balanceSatang: sql<string>`coalesce(sum(${walletLedgerPosting.amountSatang}), 0)::text`,
    })
    .from(walletLedgerAccount)
    .leftJoin(walletLedgerPosting, eq(walletLedgerAccount.id, walletLedgerPosting.accountId))
    .where(eq(walletLedgerAccount.walletId, walletId))
    .groupBy(walletLedgerAccount.type);

  const ledgerBalances = new Map<string, number>();
  for (const a of accountRows) {
    ledgerBalances.set(a.type, Number(a.balanceSatang));
  }

  const matches =
    row.spendingBalanceSatang === (ledgerBalances.get('SPENDING') ?? 0) &&
    row.earningsBalanceSatang === (ledgerBalances.get('EARNINGS') ?? 0) &&
    row.fundingReservedSatang === (ledgerBalances.get('FUNDING_RESERVED') ?? 0) &&
    row.reservedForPayoutsSatang === (ledgerBalances.get('RESERVED_FOR_PAYOUTS') ?? 0);

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
