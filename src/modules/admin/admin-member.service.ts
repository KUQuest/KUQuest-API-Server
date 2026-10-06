import { db } from '@/database/client';
import { department, faculty, occupation } from '@/database/schema/academic.schema';
import { authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';
import { profileCertificate, profileWorkExperience } from '@/database/schema/profile.schema';
import { paymentPayouts } from '@/database/schema/payment.schema';
import { quest, questAssignment, review } from '@/database/schema/quest.schema';
import { walletFundingReservationSettlement, walletWallet } from '@/database/schema/wallet.schema';
import { walletProjectionMatchesLedger } from '@/modules/wallet';
import { getProfileTags } from '@/modules/profile';
import {
  CursorInputError,
  decodeCursor,
  encodeCursor,
  parsePageLimit,
  type CursorPayload,
} from '@/shared/cursor';
import { readKeysetPage, type KeysetAnchor } from '@/shared/keyset-page';

import { and, avg, count, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';

import { formatDisplayIdSql } from './admin-display-id';
import type {
  AdminMemberCertificateItem,
  AdminMemberCertificatesData,
  AdminMemberDetailData,
  AdminMemberListItem,
  AdminMemberListQuery,
  AdminMemberProfileCollectionQuery,
  AdminMemberProfileIdentity,
  AdminMemberProfileTagsData,
  AdminMemberWorkExperienceItem,
  AdminMemberWorkExperiencesData,
} from './admin-member.schema';
import { adminMemberStatusSql } from './admin-member-status';

export type AdminMemberListPage = {
  items: AdminMemberListItem[];
  nextCursor: string | null;
};
const getAdminMemberProfileIdentity = async (
  userId: string
): Promise<AdminMemberProfileIdentity | null> => {
  const [member] = await db
    .select({ displayId: formatDisplayIdSql('member', authUser.publicSequence) })
    .from(authUser)
    .where(eq(authUser.id, userId));

  return member ?? null;
};
const assertMemberProfileCollectionCursor = async (
  cursor: CursorPayload | undefined,
  anchor: KeysetAnchor,
  memberFilter: SQL,
  resource: 'Work Experience' | 'Certificate'
): Promise<void> => {
  if (!cursor) return;

  const [row] = await db
    .select({ id: anchor.id })
    .from(anchor.time.table)
    .where(
      and(
        memberFilter,
        eq(anchor.id, cursor.id),
        sql`date_trunc('milliseconds', ${anchor.time}) = ${cursor.startTime}::timestamptz`
      )
    )
    .limit(1);
  if (!row) {
    throw new CursorInputError('INVALID_CURSOR', `cursor does not match a ${resource}`);
  }
};

export const getAdminMemberProfileTags = async (
  userId: string
): Promise<AdminMemberProfileTagsData | null> => {
  const member = await getAdminMemberProfileIdentity(userId);
  if (!member) return null;

  const tags = await getProfileTags(userId);
  return { member, tags: tags.map(({ name }) => ({ name })) };
};

export const listAdminMemberWorkExperiences = async (
  userId: string,
  query: AdminMemberProfileCollectionQuery
): Promise<AdminMemberWorkExperiencesData | null> => {
  const cursor = decodeCursor(query.cursor);
  const limit = parsePageLimit(query.limit);
  const member = await getAdminMemberProfileIdentity(userId);
  if (!member) return null;

  const where = eq(profileWorkExperience.userId, userId);
  const anchor = { time: profileWorkExperience.createdAt, id: profileWorkExperience.id };
  await assertMemberProfileCollectionCursor(cursor, anchor, where, 'Work Experience');
  const [totalRows, page] = await Promise.all([
    db.select({ total: count() }).from(profileWorkExperience).where(where),
    readKeysetPage({
      anchor,
      cursor,
      limit,
      where,
      read: ({ where: pageWhere, orderBy, limit: probe }) =>
        db
          .select({
            id: profileWorkExperience.id,
            title: profileWorkExperience.title,
            employmentType: profileWorkExperience.employmentType,
            organization: profileWorkExperience.org,
            description: profileWorkExperience.description,
            startedAt: profileWorkExperience.startedAt,
            endedAt: profileWorkExperience.endedAt,
            createdAt: profileWorkExperience.createdAt,
          })
          .from(profileWorkExperience)
          .where(pageWhere)
          .orderBy(...orderBy)
          .limit(probe),
      rowCursor: (row) => ({ startTime: row.createdAt, id: row.id }),
      invalidCursor: () =>
        new CursorInputError('INVALID_CURSOR', 'cursor does not match a Work Experience'),
    }),
  ]);

  return {
    member,
    items: page.rows.map((row): AdminMemberWorkExperienceItem => ({
      title: row.title,
      employmentType: row.employmentType,
      organization: row.organization,
      description: row.description,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
    })),
    totalCount: totalRows[0]?.total ?? 0,
    nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
  };
};

export const listAdminMemberCertificates = async (
  userId: string,
  query: AdminMemberProfileCollectionQuery
): Promise<AdminMemberCertificatesData | null> => {
  const cursor = decodeCursor(query.cursor);
  const limit = parsePageLimit(query.limit);
  const member = await getAdminMemberProfileIdentity(userId);
  if (!member) return null;

  const where = eq(profileCertificate.userId, userId);
  const anchor = { time: profileCertificate.createdAt, id: profileCertificate.id };
  await assertMemberProfileCollectionCursor(cursor, anchor, where, 'Certificate');
  const [totalRows, page] = await Promise.all([
    db.select({ total: count() }).from(profileCertificate).where(where),
    readKeysetPage({
      anchor,
      cursor,
      limit,
      where,
      read: ({ where: pageWhere, orderBy, limit: probe }) =>
        db
          .select({
            id: profileCertificate.id,
            name: profileCertificate.name,
            issuer: profileCertificate.issuer,
            issuedAt: profileCertificate.issuedAt,
            imageContentType: file.contentType,
            imageSizeBytes: file.sizeBytes,
            createdAt: profileCertificate.createdAt,
          })
          .from(profileCertificate)
          .leftJoin(file, and(eq(profileCertificate.imageFileId, file.id), isNull(file.deletedAt)))
          .where(pageWhere)
          .orderBy(...orderBy)
          .limit(probe),
      rowCursor: (row) => ({ startTime: row.createdAt, id: row.id }),
      invalidCursor: () =>
        new CursorInputError('INVALID_CURSOR', 'cursor does not match a Certificate'),
    }),
  ]);

  return {
    member,
    items: page.rows.map((row): AdminMemberCertificateItem => ({
      name: row.name,
      issuer: row.issuer,
      issuedAt: row.issuedAt,
      image:
        row.imageContentType === null || row.imageSizeBytes === null
          ? null
          : { contentType: row.imageContentType, sizeBytes: row.imageSizeBytes },
    })),
    totalCount: totalRows[0]?.total ?? 0,
    nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
  };
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

  const displayId = formatDisplayIdSql('member', authUser.publicSequence);
  const page = await readKeysetPage({
    anchor: { time: authUser.createdAt, id: authUser.id },
    cursor,
    limit,
    where: and(...conditions),
    read: ({ where, orderBy, limit: probe }) =>
      db
        .select({
          id: authUser.id,
          displayId,
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
          memberStatus: adminMemberStatusSql(),
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
      displayId: r.displayId,
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
      memberStatus: r.memberStatus,
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
      displayId: formatDisplayIdSql('member', authUser.publicSequence),
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
      memberStatus: adminMemberStatusSql(),
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
      displayId: memberRow.displayId,
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
      memberStatus: memberRow.memberStatus,
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
