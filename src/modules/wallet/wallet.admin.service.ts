import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import {
  walletLedgerAccount,
  walletLedgerPosting,
  walletWallet,
} from '@/database/schema/wallet.schema';
import { CursorInputError, decodeCursor, encodeCursor, parsePageLimit } from '@/shared/cursor';
import { readKeysetPage } from '@/shared/keyset-page';

import { and, eq, ilike, or, sql } from 'drizzle-orm';

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
