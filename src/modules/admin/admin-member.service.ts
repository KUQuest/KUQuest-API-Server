import { db } from '@/database/client';
import { department, faculty, occupation } from '@/database/schema/academic.schema';
import { authUser } from '@/database/schema/auth.schema';
import { paymentPayouts } from '@/database/schema/payment.schema';
import { quest, questAssignment, review } from '@/database/schema/quest.schema';
import { walletFundingReservationSettlement, walletWallet } from '@/database/schema/wallet.schema';
import { walletProjectionMatchesLedger } from '@/modules/wallet';
import { CursorInputError, decodeCursor, encodeCursor, parsePageLimit } from '@/shared/cursor';
import { readKeysetPage } from '@/shared/keyset-page';

import { and, avg, count, eq, ilike, or, sql } from 'drizzle-orm';

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
  query: AdminMemberListQuery = {}
): Promise<AdminMemberListPage> => {
  const cursor = decodeCursor(query.cursor);
  const limit = parsePageLimit(query.limit);
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
        ilike(authUser.email, s)
      )
    );
  }

  const page = await readKeysetPage({
    anchor: { time: authUser.createdAt, id: authUser.id },
    cursor,
    limit,
    where: and(...conditions),
    read: ({ where, orderBy, limit: probe }) =>
      db
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
        .where(where)
        .orderBy(...orderBy)
        .limit(probe),
    rowCursor: (row) => ({ startTime: row.createdAt, id: row.id }),
    invalidCursor: () => new CursorInputError('INVALID_CURSOR', 'cursor does not match a Member'),
  });

  const items: AdminMemberListItem[] = page.rows.map((r) => {
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
    nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
  };
};

export const getAdminMemberDetail = async (
  userId: string
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
  const [wallet] = await db.select().from(walletWallet).where(eq(walletWallet.userId, userId));

  let walletData: AdminMemberDetailData['wallet'] = null;
  if (wallet) {
    const matches = await walletProjectionMatchesLedger(wallet.id, {
      spendingBalanceSatang: wallet.spendingBalanceSatang,
      earningsBalanceSatang: wallet.earningsBalanceSatang,
      fundingReservedSatang: wallet.fundingReservedSatang,
      reservedForPayoutsSatang: wallet.reservedForPayoutsSatang,
    });

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
        eq(questAssignment.assignmentStatus, 'ASSIGNMENT_COMPLETED')
      )
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
    .where(and(eq(paymentPayouts.userId, userId), eq(paymentPayouts.payoutStatus, 'SUCCEEDED')));

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
