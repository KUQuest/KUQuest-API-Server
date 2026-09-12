import { db } from '@/database/client';
import { department, faculty, occupation } from '@/database/schema/academic.schema';
import { authUser } from '@/database/schema/auth.schema';
import { paymentPayouts } from '@/database/schema/payment.schema';
import { quest, questAssignment, review } from '@/database/schema/quest.schema';
import {
  walletFundingReservationSettlement,
  walletLedgerAccount,
  walletLedgerPosting,
  walletWallet,
} from '@/database/schema/wallet.schema';
import { decodeCursor, encodeCursor } from '@/shared/cursor';

import { and, avg, count, desc, eq, ilike, lt, or, sql } from 'drizzle-orm';

import type {
  AdminMemberDetailData,
  AdminMemberListItem,
  AdminMemberListQuery,
} from './admin-member.schema';

export type AdminMemberListPage = {
  items: AdminMemberListItem[];
  nextCursor: string | null;
};

export const listAdminMembers = async (
  query: AdminMemberListQuery = {},
): Promise<AdminMemberListPage> => {
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
  const conditions = [];

  if (query.walletStatus) {
    conditions.push(eq(walletWallet.walletStatus, query.walletStatus));
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
          lt(authUser.createdAt, cursorDate),
          and(
            eq(authUser.createdAt, cursorDate),
            lt(authUser.id, parsed.id),
          ),
        ),
      );
    }
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      id: authUser.id,
      email: authUser.email,
      firstName: authUser.firstName,
      lastName: authUser.lastName,
      studentId: authUser.studentId,
      telephone: authUser.telephone,
      academicYear: authUser.academicYear,
      createdAt: authUser.createdAt,
      departmentName: department.name,
      facultyName: faculty.name,
      occupationName: occupation.name,
      walletId: walletWallet.id,
      walletStatus: walletWallet.walletStatus,
      spendingBalanceSatang: walletWallet.spendingBalanceSatang,
      earningsBalanceSatang: walletWallet.earningsBalanceSatang,
      fundingReservedSatang: walletWallet.fundingReservedSatang,
      reservedForPayoutsSatang: walletWallet.reservedForPayoutsSatang,
    })
    .from(authUser)
    .leftJoin(department, eq(authUser.departmentId, department.id))
    .leftJoin(faculty, eq(department.facultyId, faculty.id))
    .leftJoin(occupation, eq(authUser.occupationId, occupation.id))
    .leftJoin(walletWallet, eq(authUser.id, walletWallet.userId))
    .where(whereClause)
    .orderBy(desc(authUser.createdAt), desc(authUser.id))
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

  const items: AdminMemberListItem[] = pageRows.map((r) => {
    let wallet: AdminMemberListItem['wallet'] = null;
    if (r.walletId && r.walletStatus) {
      const spending = r.spendingBalanceSatang ?? 0;
      const earnings = r.earningsBalanceSatang ?? 0;
      const fundingReserved = r.fundingReservedSatang ?? 0;
      const payoutReserved = r.reservedForPayoutsSatang ?? 0;
      wallet = {
        id: r.walletId,
        walletStatus: r.walletStatus,
        spendingBalanceSatang: spending,
        earningsBalanceSatang: earnings,
        totalBalanceSatang: spending + earnings + fundingReserved + payoutReserved,
      };
    }

    return {
      id: r.id,
      email: r.email,
      firstName: r.firstName,
      lastName: r.lastName,
      studentId: r.studentId,
      telephone: r.telephone,
      academicYear: r.academicYear,
      faculty: r.facultyName,
      department: r.departmentName,
      occupation: r.occupationName,
      wallet,
      createdAt: r.createdAt.toISOString(),
    };
  });

  return {
    items,
    nextCursor,
  };
};

export const getAdminMemberDetail = async (
  userId: string,
): Promise<AdminMemberDetailData | null> => {
  const [memberRow] = await db
    .select({
      id: authUser.id,
      email: authUser.email,
      firstName: authUser.firstName,
      lastName: authUser.lastName,
      studentId: authUser.studentId,
      telephone: authUser.telephone,
      bio: authUser.bio,
      academicYear: authUser.academicYear,
      createdAt: authUser.createdAt,
      departmentName: department.name,
      facultyName: faculty.name,
      occupationName: occupation.name,
    })
    .from(authUser)
    .leftJoin(department, eq(authUser.departmentId, department.id))
    .leftJoin(faculty, eq(department.facultyId, faculty.id))
    .leftJoin(occupation, eq(authUser.occupationId, occupation.id))
    .where(eq(authUser.id, userId));

  if (!memberRow) {
    return null;
  }

  // Fetch wallet
  const [wallet] = await db
    .select()
    .from(walletWallet)
    .where(eq(walletWallet.userId, userId));

  let walletData: AdminMemberDetailData['wallet'] = null;
  if (wallet) {
    const accountRows = await db
      .select({
        type: walletLedgerAccount.type,
        balanceSatang: sql<string>`coalesce(sum(${walletLedgerPosting.amountSatang}), 0)::text`,
      })
      .from(walletLedgerAccount)
      .leftJoin(walletLedgerPosting, eq(walletLedgerAccount.id, walletLedgerPosting.accountId))
      .where(eq(walletLedgerAccount.walletId, wallet.id))
      .groupBy(walletLedgerAccount.type);

    const ledgerBalances = new Map<string, number>();
    for (const a of accountRows) {
      ledgerBalances.set(a.type, Number(a.balanceSatang));
    }

    const matches =
      wallet.spendingBalanceSatang === (ledgerBalances.get('SPENDING') ?? 0) &&
      wallet.earningsBalanceSatang === (ledgerBalances.get('EARNINGS') ?? 0) &&
      wallet.fundingReservedSatang === (ledgerBalances.get('FUNDING_RESERVED') ?? 0) &&
      wallet.reservedForPayoutsSatang === (ledgerBalances.get('RESERVED_FOR_PAYOUTS') ?? 0);

    const totalBalanceSatang =
      wallet.spendingBalanceSatang +
      wallet.earningsBalanceSatang +
      wallet.fundingReservedSatang +
      wallet.reservedForPayoutsSatang;

    walletData = {
      id: wallet.id,
      walletStatus: wallet.walletStatus,
      spendingBalanceSatang: wallet.spendingBalanceSatang,
      earningsBalanceSatang: wallet.earningsBalanceSatang,
      fundingReservedSatang: wallet.fundingReservedSatang,
      reservedForPayoutsSatang: wallet.reservedForPayoutsSatang,
      totalBalanceSatang,
      projectionMatchesLedger: matches,
    };
  }

  // Aggregate marketplace stats
  const [createdQuests] = await db
    .select({ total: count() })
    .from(quest)
    .where(eq(quest.hirerId, userId));

  const [completedAssignments] = await db
    .select({ total: count() })
    .from(questAssignment)
    .where(
      and(
        eq(questAssignment.workerId, userId),
        eq(questAssignment.assignmentStatus, 'ASSIGNMENT_COMPLETED'),
      ),
    );

  const [reviewStats] = await db
    .select({
      total: count(),
      average: avg(review.rating),
    })
    .from(review)
    .where(eq(review.revieweeId, userId));

  const [payoutsStats] = await db
    .select({
      total: count(),
      totalPaidOut: sql<string>`coalesce(sum(${paymentPayouts.principalSatang}), 0)::text`,
    })
    .from(paymentPayouts)
    .where(
      and(
        eq(paymentPayouts.userId, userId),
        eq(paymentPayouts.payoutStatus, 'SUCCEEDED'),
      ),
    );

  const [earnedStats] = await db
    .select({
      totalEarned: sql<string>`coalesce(sum(${walletFundingReservationSettlement.recipientAmountSatang}), 0)::text`,
    })
    .from(walletFundingReservationSettlement)
    .where(eq(walletFundingReservationSettlement.recipientUserId, userId));

  return {
    member: {
      id: memberRow.id,
      email: memberRow.email,
      firstName: memberRow.firstName,
      lastName: memberRow.lastName,
      studentId: memberRow.studentId,
      telephone: memberRow.telephone,
      bio: memberRow.bio,
      academicYear: memberRow.academicYear,
      faculty: memberRow.facultyName,
      department: memberRow.departmentName,
      occupation: memberRow.occupationName,
      createdAt: memberRow.createdAt.toISOString(),
    },
    wallet: walletData,
    stats: {
      questsCreatedCount: createdQuests?.total ?? 0,
      questsCompletedAsWorkerCount: completedAssignments?.total ?? 0,
      reviewsReceivedCount: reviewStats?.total ?? 0,
      averageRating: reviewStats?.average ? Number(reviewStats.average) : null,
      payoutsCount: payoutsStats?.total ?? 0,
      totalEarnedSatang: Number(earnedStats?.totalEarned ?? 0),
      totalPaidOutSatang: Number(payoutsStats?.totalPaidOut ?? 0),
    },
  };
};
