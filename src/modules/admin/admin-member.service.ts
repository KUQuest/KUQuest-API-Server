import { db } from '@/database/client';
import { auditRecord } from '@/database/schema/audit.schema';
import { department, faculty, occupation } from '@/database/schema/academic.schema';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import {
  adminConductReport,
  adminReportCase,
  memberPenaltyRecord,
} from '@/database/schema/admin.schema';
import { file } from '@/database/schema/file.schema';
import { profileCertificate, profileWorkExperience } from '@/database/schema/profile.schema';
import { paymentPayouts } from '@/database/schema/payment.schema';
import {
  proofSubmission,
  quest,
  questAssignment,
  questCandidateTeamV2Member,
  questCompletionConfirmation,
  questStatus as persistedQuestStatus,
  questTeamMember,
  questV2CompletionConfirmation,
  questV2ProofSubmission,
  review,
} from '@/database/schema/quest.schema';
import { walletFundingReservationSettlement, walletWallet } from '@/database/schema/wallet.schema';
import { validReceivedReviewFilter } from '@/modules/quest/shared/rating-review.service';
import { walletProjectionMatchesLedger } from '@/modules/wallet';
import { getProfileTags } from '@/modules/profile';
import type {
  AssignmentStatus,
  QuestStatus,
} from '@/modules/quest/shared/contracts/quest.contract';
import {
  CursorInputError,
  decodeCursor,
  encodeCursor,
  parsePageLimit,
  type CursorPayload,
} from '@/shared/cursor';
import {
  readKeysetPage,
  type KeysetAnchor,
  type KeysetCursorAnchor,
  type KeysetSort,
} from '@/shared/keyset-page';

import {
  and,
  asc,
  avg,
  count,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  isNull,
  not,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { formatDisplayIdSql } from './admin-display-id';
import type {
  AdminMemberCertificateItem,
  AdminMemberCertificatesData,
  AdminMemberDetailData,
  AdminMemberHistoryData,
  AdminMemberHistoryItem,
  AdminMemberHistoryQuery,
  AdminMemberHistoryRelatedMember,
  AdminMemberListItem,
  AdminMemberListQuery,
  AdminMemberPenaltyHistoryData,
  AdminMemberProfileCollectionQuery,
  AdminMemberProfileIdentity,
  AdminMemberProfileTagsData,
  AdminMemberReviewsData,
  AdminMemberReviewsQuery,
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
  resource: 'Work Experience' | 'Certificate' | 'Penalty History'
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

const adminMemberPenaltyReversal = alias(memberPenaltyRecord, 'admin_member_penalty_reversal');
const adminMemberPenaltyOriginal = alias(memberPenaltyRecord, 'admin_member_penalty_original');
const adminMemberPenaltyRecalculatedFrom = alias(
  memberPenaltyRecord,
  'admin_member_penalty_recalculated_from'
);
const adminMemberPenaltyReplacement = alias(
  memberPenaltyRecord,
  'admin_member_penalty_replacement'
);
const adminMemberPenaltyActor = alias(authAdmin, 'admin_member_penalty_actor');

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

export const listAdminMemberPenaltyHistory = async (
  userId: string,
  query: AdminMemberProfileCollectionQuery
): Promise<AdminMemberPenaltyHistoryData | null> => {
  const cursor = decodeCursor(query.cursor);
  const limit = parsePageLimit(query.limit);
  const [member] = await db
    .select({
      displayId: formatDisplayIdSql('member', authUser.publicSequence),
      createdAt: authUser.createdAt,
    })
    .from(authUser)
    .where(eq(authUser.id, userId));

  if (!member) return null;

  const where = eq(memberPenaltyRecord.memberId, userId);
  const anchor = { time: memberPenaltyRecord.createdAt, id: memberPenaltyRecord.id };
  await assertMemberProfileCollectionCursor(cursor, anchor, where, 'Penalty History');

  const originalMisconduct = sql<boolean>`
    ${memberPenaltyRecord.ladder} = 'MISCONDUCT'
    AND ${memberPenaltyRecord.source} IN ('REPORT_CASE', 'CONDUCT_REPORT', 'ADMIN')
    AND ${memberPenaltyRecord.result} <> 'PENALTY_REVERSAL'
    AND ${memberPenaltyRecord.recalculationOfRecordId} IS NULL
    AND ${memberPenaltyRecord.createdAt} >= ${member.createdAt.toISOString()}::timestamptz
  `;
  const hasPenaltyReversal = exists(
    db
      .select({ id: adminMemberPenaltyReversal.id })
      .from(adminMemberPenaltyReversal)
      .where(eq(adminMemberPenaltyReversal.reversalOfRecordId, memberPenaltyRecord.id))
  );
  const effectiveActiveMisconduct = sql<boolean>`
    ${originalMisconduct}
    AND ${memberPenaltyRecord.result} <> 'PENALTY_EXEMPT'
    AND ${not(hasPenaltyReversal)}
  `;
  const effectivePenalty = sql<boolean>`
    ${memberPenaltyRecord.result} NOT IN ('PENALTY_EXEMPT', 'PENALTY_REVERSAL')
    AND ${not(hasPenaltyReversal)}
  `;

  const [countRows, page] = await Promise.all([
    db
      .select({
        totalCount: count(),
        confirmedMisconductCount: sql<number>`
          count(*) FILTER (WHERE ${originalMisconduct})
        `.mapWith(Number),
        effectiveActiveMisconductPenaltyCount: sql<number>`
          count(*) FILTER (WHERE ${effectiveActiveMisconduct})
        `.mapWith(Number),
        reviewLadderRecordCount: sql<number>`
          count(*) FILTER (
            WHERE ${memberPenaltyRecord.ladder} = 'REVIEW'
              AND ${memberPenaltyRecord.result} <> 'PENALTY_REVERSAL'
          )
        `.mapWith(Number),
      })
      .from(memberPenaltyRecord)
      .where(where),
    readKeysetPage({
      anchor,
      cursor,
      limit,
      where,
      read: ({ where: pageWhere, orderBy, limit: probe }) =>
        db
          .select({
            id: memberPenaltyRecord.id,
            ladder: memberPenaltyRecord.ladder,
            source: memberPenaltyRecord.source,
            sourceDisplayId: sql<string | null>`case
              when ${memberPenaltyRecord.source} = 'REPORT_CASE'
                and ${adminReportCase.id} is not null
                then ${formatDisplayIdSql('reportCase', adminReportCase.publicSequence)}
              when ${memberPenaltyRecord.source} = 'CONDUCT_REPORT'
                and ${adminConductReport.id} is not null
                then ${formatDisplayIdSql('conductReport', adminConductReport.publicSequence)}
              when ${memberPenaltyRecord.source} = 'REVIEW_AVERAGE'
                and ${review.id} is not null
                and ${quest.id} is not null
                then ${formatDisplayIdSql('quest', quest.publicSequence)}
              else null
            end`,
            sequenceNumber: memberPenaltyRecord.sequenceNumber,
            result: memberPenaltyRecord.result,
            actorType: memberPenaltyRecord.actorType,
            actorFirstName: adminMemberPenaltyActor.firstName,
            actorLastName: adminMemberPenaltyActor.lastName,
            reasonCode: memberPenaltyRecord.reasonCode,
            adminNote: memberPenaltyRecord.adminNote,
            createdAt: memberPenaltyRecord.createdAt,
            reviewRating: review.rating,
            isEffective: effectivePenalty,
            isEffectiveActiveMisconductPenalty: effectiveActiveMisconduct,
            originalSequenceNumber: adminMemberPenaltyOriginal.sequenceNumber,
            originalResult: adminMemberPenaltyOriginal.result,
            originalCreatedAt: adminMemberPenaltyOriginal.createdAt,
            reversalSequenceNumber: adminMemberPenaltyReversal.sequenceNumber,
            reversalResult: adminMemberPenaltyReversal.result,
            reversalCreatedAt: adminMemberPenaltyReversal.createdAt,
            recalculatedFromSequenceNumber: adminMemberPenaltyRecalculatedFrom.sequenceNumber,
            recalculatedFromResult: adminMemberPenaltyRecalculatedFrom.result,
            recalculatedFromCreatedAt: adminMemberPenaltyRecalculatedFrom.createdAt,
            replacementSequenceNumber: adminMemberPenaltyReplacement.sequenceNumber,
            replacementResult: adminMemberPenaltyReplacement.result,
            replacementCreatedAt: adminMemberPenaltyReplacement.createdAt,
          })
          .from(memberPenaltyRecord)
          .leftJoin(
            adminReportCase,
            and(
              eq(adminReportCase.id, memberPenaltyRecord.sourceId),
              eq(memberPenaltyRecord.source, 'REPORT_CASE')
            )
          )
          .leftJoin(
            adminConductReport,
            and(
              eq(adminConductReport.id, memberPenaltyRecord.sourceId),
              eq(memberPenaltyRecord.source, 'CONDUCT_REPORT')
            )
          )
          .leftJoin(
            review,
            and(
              eq(review.id, memberPenaltyRecord.sourceId),
              eq(memberPenaltyRecord.source, 'REVIEW_AVERAGE')
            )
          )
          .leftJoin(quest, eq(quest.id, review.questId))
          .leftJoin(
            adminMemberPenaltyOriginal,
            eq(adminMemberPenaltyOriginal.id, memberPenaltyRecord.reversalOfRecordId)
          )
          .leftJoin(
            adminMemberPenaltyReversal,
            eq(adminMemberPenaltyReversal.reversalOfRecordId, memberPenaltyRecord.id)
          )
          .leftJoin(
            adminMemberPenaltyRecalculatedFrom,
            eq(adminMemberPenaltyRecalculatedFrom.id, memberPenaltyRecord.recalculationOfRecordId)
          )
          .leftJoin(
            adminMemberPenaltyReplacement,
            eq(adminMemberPenaltyReplacement.recalculationOfRecordId, memberPenaltyRecord.id)
          )
          .leftJoin(
            adminMemberPenaltyActor,
            eq(adminMemberPenaltyActor.id, memberPenaltyRecord.actorAdminId)
          )
          .where(pageWhere)
          .orderBy(...orderBy)
          .limit(probe),
      rowCursor: (row) => ({ startTime: row.createdAt, id: row.id }),
      invalidCursor: () =>
        new CursorInputError('INVALID_CURSOR', 'cursor does not match a Penalty History record'),
    }),
  ]);

  const items: AdminMemberPenaltyHistoryData['items'] = page.rows.map((row) => {
    const linkedRecord =
      row.result === 'PENALTY_REVERSAL'
        ? {
            sequenceNumber: row.originalSequenceNumber,
            result: row.originalResult,
            createdAt: row.originalCreatedAt,
          }
        : {
            sequenceNumber: row.reversalSequenceNumber,
            result: row.reversalResult,
            createdAt: row.reversalCreatedAt,
          };
    const reversal =
      linkedRecord.sequenceNumber === null ||
      linkedRecord.result === null ||
      linkedRecord.createdAt === null
        ? null
        : {
            relation:
              row.result === 'PENALTY_REVERSAL'
                ? ('REVERSAL_OF' as const)
                : ('REVERSED_BY' as const),
            sequenceNumber: linkedRecord.sequenceNumber,
            result: linkedRecord.result,
            createdAt: linkedRecord.createdAt.toISOString(),
          };
    const recalculatedFrom =
      row.recalculatedFromSequenceNumber === null ||
      row.recalculatedFromResult === null ||
      row.recalculatedFromCreatedAt === null
        ? null
        : {
            sequenceNumber: row.recalculatedFromSequenceNumber,
            result: row.recalculatedFromResult,
            createdAt: row.recalculatedFromCreatedAt.toISOString(),
          };
    const replacedBy =
      row.replacementSequenceNumber === null ||
      row.replacementResult === null ||
      row.replacementCreatedAt === null
        ? null
        : {
            sequenceNumber: row.replacementSequenceNumber,
            result: row.replacementResult,
            createdAt: row.replacementCreatedAt.toISOString(),
          };
    const adminDisplayName = [row.actorFirstName, row.actorLastName]
      .filter((name): name is string => name !== null)
      .join(' ');

    return {
      ladder: row.ladder,
      source: row.source,
      sourceDisplayId: row.sourceDisplayId,
      sequenceNumber: row.sequenceNumber,
      result: row.result,
      actor: {
        type: row.actorType,
        displayName: row.actorType === 'SYSTEM' ? 'System' : adminDisplayName || 'Admin',
      },
      reasonCode: row.reasonCode,
      adminNote: row.adminNote,
      createdAt: row.createdAt.toISOString(),
      reviewRating: row.reviewRating,
      isEffective: row.isEffective,
      isEffectiveActiveMisconductPenalty: row.isEffectiveActiveMisconductPenalty,
      reversal,
      recalculatedFrom,
      replacedBy,
    };
  });
  const counts = countRows[0];

  return {
    member: { displayId: member.displayId },
    confirmedMisconductCount: counts?.confirmedMisconductCount ?? 0,
    effectiveActiveMisconductPenaltyCount: counts?.effectiveActiveMisconductPenaltyCount ?? 0,
    reviewLadderRecordCount: counts?.reviewLadderRecordCount ?? 0,
    versionToken: counts?.totalCount ?? 0,
    items,
    totalCount: counts?.totalCount ?? 0,
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

type MemberHistoryQuestFields = {
  questId: string;
  questDisplayId: string;
  questTitle: string;
  questStatus: string;
  questCreatedAt: Date;
  questStatusChangedAt: string | null;
  sortCreatedAt: string;
};

type MemberHirerHistoryRow = MemberHistoryQuestFields & {
  id: string;
  createdAt: Date;
};

type MemberWorkerHistoryRow = MemberHistoryQuestFields & {
  id: string;
  createdAt: Date;
  assignmentStatus: string;
  startedAt: Date | null;
  assignmentStatusChangedAt: string | null;
  hirerId: string;
  hirerDisplayId: string;
  hirerFirstName: string;
  hirerLastName: string;
};

type MemberHistoryPageRow =
  (MemberHirerHistoryRow & { role: 'HIRER' }) | (MemberWorkerHistoryRow & { role: 'WORKER' });

const memberHistoryHirer = alias(authUser, 'admin_member_history_hirer');
// Keep microseconds when the service merges the two history streams.

const memberHistoryTimestampText = (time: SQLWrapper) =>
  sql<string>`to_char(${time} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const memberHistoryQuestCompletedAt = () =>
  sql<string | null>`(
    select ${memberHistoryTimestampText(sql`max(completion_event.event_at)`)}
    from (
      select "proof_submission"."reviewed_at" as event_at
      from ${proofSubmission}
      where "proof_submission"."quest_id" = "quest"."id"
        and "quest"."api_version" = 'v1'
        and "proof_submission"."submission_status" = 'PROOF_APPROVED'
        and "proof_submission"."reviewed_at" is not null
      union all
      select "quest_v2_proof_submission"."reviewed_at" as event_at
      from ${questV2ProofSubmission}
      where "quest_v2_proof_submission"."quest_id" = "quest"."id"
        and "quest"."api_version" = 'v2'
        and "quest_v2_proof_submission"."submission_status" = 'PROOF_APPROVED'
        and "quest_v2_proof_submission"."reviewed_at" is not null
      union all
      select "quest_completion_confirmation"."confirmed_at" as event_at
      from ${questCompletionConfirmation}
      where "quest_completion_confirmation"."quest_id" = "quest"."id"
        and "quest"."api_version" = 'v1'
      union all
      select "quest_v2_completion_confirmation"."confirmed_at" as event_at
      from ${questV2CompletionConfirmation}
      where "quest_v2_completion_confirmation"."quest_id" = "quest"."id"
        and "quest"."api_version" = 'v2'
    ) as completion_event
  )`;

const memberHistoryQuestStatusChangedAt = () =>
  sql<string | null>`(
    coalesce(
      (
        select ${memberHistoryTimestampText(auditRecord.createdAt)}
        from ${auditRecord}
        where ${auditRecord.resourceType} = 'QUEST'
          and ${auditRecord.resourceId} = "quest"."id"::text
          and ${auditRecord.action} = 'QUEST_STATE_CHANGED'
          and ${auditRecord.newValue}->>'state' = "quest"."quest_status"::text
        order by ${auditRecord.createdAt} desc, ${auditRecord.id} desc
        limit 1
      ),
      case "quest"."quest_status"::text
        when 'QUEST_FAILED'
          then ${memberHistoryTimestampText(sql`"quest"."failed_at"`)}
        when 'QUEST_CANCELLED'
          then ${memberHistoryTimestampText(sql`"quest"."cancelled_at"`)}
        when 'QUEST_COMPLETED'
          then ${memberHistoryQuestCompletedAt()}
        else null
      end
    )
  )`;

// Use Assignment events before Proof, confirmation, or terminal Quest events.

const memberHistoryAssignmentStatusChangedAt = () =>
  sql<string | null>`(
    coalesce(
      (
        select ${memberHistoryTimestampText(auditRecord.createdAt)}
        from ${auditRecord}
        where ${auditRecord.resourceType} = 'ASSIGNMENT'
          and ${auditRecord.resourceId} = "quest_assignment"."id"::text
          and ${auditRecord.action} = 'ASSIGNMENT_STATE_CHANGED'
          and ${auditRecord.newValue}->>'state' = "quest_assignment"."assignment_status"::text
        order by ${auditRecord.createdAt} desc, ${auditRecord.id} desc
        limit 1
      ),
      (
        select ${memberHistoryTimestampText(proofSubmission.reviewedAt)}
        from ${proofSubmission}
        left join ${questTeamMember}
          on "quest_team_member"."team_id" = "proof_submission"."team_id"
          and "quest_team_member"."user_id" = "quest_assignment"."worker_id"
        where "proof_submission"."quest_id" = "quest_assignment"."quest_id"
          and "proof_submission"."submission_status" = 'PROOF_APPROVED'
          and "proof_submission"."reviewed_at" is not null
          and "quest_assignment"."assignment_status" = 'ASSIGNMENT_COMPLETED'
          and "quest"."api_version" = 'v1'
          and (
            "quest"."quest_status" = 'QUEST_COMPLETED'
            or (
              "quest"."quest_status" = 'QUEST_FAILED'
              and "quest"."failed_at" <= "proof_submission"."reviewed_at"
            )
          )
          and (
            "proof_submission"."worker_id" = "quest_assignment"."worker_id"
            or "quest_team_member"."user_id" is not null
          )
        order by "proof_submission"."reviewed_at" desc, "proof_submission"."id" desc
        limit 1
      ),
      (
        select ${memberHistoryTimestampText(questCompletionConfirmation.confirmedAt)}
        from ${questCompletionConfirmation}
        left join ${questTeamMember}
          on "quest_team_member"."team_id" = "quest_completion_confirmation"."team_id"
          and "quest_team_member"."user_id" = "quest_assignment"."worker_id"
        where "quest_completion_confirmation"."quest_id" = "quest_assignment"."quest_id"
          and "quest_assignment"."assignment_status" = 'ASSIGNMENT_COMPLETED'
          and "quest"."api_version" = 'v1'
          and (
            "quest_completion_confirmation"."worker_id" = "quest_assignment"."worker_id"
            or "quest_team_member"."user_id" is not null
          )
        order by
          "quest_completion_confirmation"."confirmed_at" desc,
          "quest_completion_confirmation"."id" desc
        limit 1
      ),
      (
        select ${memberHistoryTimestampText(questV2ProofSubmission.reviewedAt)}
        from ${questV2ProofSubmission}
        left join ${questCandidateTeamV2Member}
          on "quest_candidate_team_v2_member"."team_id" =
            "quest_v2_proof_submission"."team_id"
          and "quest_candidate_team_v2_member"."member_id" = "quest_assignment"."worker_id"
        where "quest_v2_proof_submission"."quest_id" = "quest_assignment"."quest_id"
          and "quest_v2_proof_submission"."submission_status" = 'PROOF_APPROVED'
          and "quest_v2_proof_submission"."reviewed_at" is not null
          and "quest_assignment"."assignment_status" = 'ASSIGNMENT_COMPLETED'
          and "quest"."api_version" = 'v2'
          and (
            "quest_v2_proof_submission"."worker_id" = "quest_assignment"."worker_id"
            or "quest_candidate_team_v2_member"."member_id" is not null
          )
        order by
          "quest_v2_proof_submission"."reviewed_at" desc,
          "quest_v2_proof_submission"."id" desc
        limit 1
      ),
      (
        select to_char(
          "quest_v2_completion_confirmation"."confirmed_at" AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        )
        from ${questV2CompletionConfirmation}
        left join ${questCandidateTeamV2Member}
          on "quest_candidate_team_v2_member"."team_id" =
            "quest_v2_completion_confirmation"."team_id"
          and "quest_candidate_team_v2_member"."member_id" = "quest_assignment"."worker_id"
        where "quest_v2_completion_confirmation"."quest_id" = "quest_assignment"."quest_id"
          and "quest_assignment"."assignment_status" = 'ASSIGNMENT_COMPLETED'
          and "quest"."api_version" = 'v2'
          and (
            "quest_v2_completion_confirmation"."worker_id" = "quest_assignment"."worker_id"
            or "quest_candidate_team_v2_member"."member_id" is not null
          )
        order by
          "quest_v2_completion_confirmation"."confirmed_at" desc,
          "quest_v2_completion_confirmation"."id" desc
        limit 1
      ),
      case
        when "quest_assignment"."assignment_status" = 'ASSIGNMENT_COMPLETED'
          and "quest"."quest_status" = 'QUEST_COMPLETED'
        then ${memberHistoryQuestStatusChangedAt()}
        when "quest_assignment"."assignment_status" = 'ASSIGNMENT_COMPLETED'
          and "quest"."quest_status" = 'QUEST_FAILED'
          and "quest"."api_version" = 'v1'
        then ${memberHistoryQuestStatusChangedAt()}
        when "quest_assignment"."assignment_status" = 'ASSIGNMENT_INCOMPLETE'
          and "quest"."quest_status" = 'QUEST_FAILED'
        then ${memberHistoryQuestStatusChangedAt()}
        when "quest_assignment"."assignment_status" = 'ASSIGNMENT_CANCELLED'
          and "quest"."quest_status" = 'QUEST_CANCELLED'
        then ${memberHistoryQuestStatusChangedAt()}
        else null
      end
    )
  )`;

// Bind the cursor to its role and filters so a reused cursor cannot skip matching rows.
const memberHistoryCursorScope = (
  role: 'HIRER' | 'WORKER',
  query: AdminMemberHistoryQuery
): string => {
  const questStatusFilter =
    query.questStatus === undefined
      ? 'N'
      : persistedQuestStatus.enumValues.indexOf(query.questStatus).toString(36).toUpperCase();
  const assignmentStatusFilter = query.assignmentStatus ?? 'N';
  return `MH_${role}_${query.role ?? 'ALL'}_${questStatusFilter}_${assignmentStatusFilter}`;
};

const memberHistoryFiltersFor = (userId: string, query: AdminMemberHistoryQuery) => {
  const hirerAssignmentFilter = query.assignmentStatus
    ? exists(
        db
          .select({ id: questAssignment.id })
          .from(questAssignment)
          .where(
            and(
              eq(questAssignment.questId, quest.id),
              eq(questAssignment.assignmentStatus, query.assignmentStatus)
            )
          )
      )
    : undefined;
  const hirerWhere = and(
    eq(quest.hirerId, userId),
    query.role === 'WORKER' ? sql`false` : undefined,
    query.questStatus ? sql`${quest.questStatus} = ${query.questStatus}::quest_status` : undefined,
    hirerAssignmentFilter
  );
  const workerWhere = and(
    eq(questAssignment.workerId, userId),
    query.role === 'HIRER' ? sql`false` : undefined,
    query.questStatus ? sql`${quest.questStatus} = ${query.questStatus}::quest_status` : undefined,
    query.assignmentStatus
      ? eq(questAssignment.assignmentStatus, query.assignmentStatus)
      : undefined
  );
  return { hirerWhere, workerWhere };
};

const readMemberHistoryCursorAnchor = async (
  userId: string,
  cursor: CursorPayload,
  query: AdminMemberHistoryQuery
) => {
  const { hirerWhere, workerWhere } = memberHistoryFiltersFor(userId, query);
  const hirerScope = memberHistoryCursorScope('HIRER', query);
  const workerScope = memberHistoryCursorScope('WORKER', query);
  const readHirer = async () => {
    const [row] = await db
      .select({ startTime: quest.createdAt })
      .from(quest)
      .where(and(eq(quest.id, cursor.id), hirerWhere))
      .limit(1);
    return row ? { ...row, id: cursor.id, scope: hirerScope } : undefined;
  };
  const readWorker = async () => {
    const [row] = await db
      .select({ startTime: questAssignment.createdAt })
      .from(questAssignment)
      .innerJoin(quest, eq(quest.id, questAssignment.questId))
      .where(and(eq(questAssignment.id, cursor.id), workerWhere))
      .limit(1);
    return row ? { ...row, id: cursor.id, scope: workerScope } : undefined;
  };

  if (cursor.scope === hirerScope) return readHirer();
  if (cursor.scope === workerScope) return readWorker();
  return undefined;
};

const memberHistoryCursorAnchorFor = (
  role: 'HIRER' | 'WORKER',
  target: KeysetAnchor,
  userId: string,
  query: AdminMemberHistoryQuery
): KeysetCursorAnchor => ({
  read: (cursor) => readMemberHistoryCursorAnchor(userId, cursor, query),
  boundary: (anchor, sort) => {
    const anchorRow =
      anchor.scope === memberHistoryCursorScope('HIRER', query)
        ? sql`(
            select ${quest.createdAt}, ${quest.id}, 'HIRER'::text
            from ${quest}
            where ${quest.id} = ${anchor.id}
          )`
        : sql`(
            select ${questAssignment.createdAt}, ${questAssignment.id}, 'WORKER'::text
            from ${questAssignment}
            where ${questAssignment.id} = ${anchor.id}
          )`;
    return sort === 'oldest'
      ? sql`(${target.time}, ${target.id}, ${role}::text) > ${anchorRow}`
      : sql`(${target.time}, ${target.id}, ${role}::text) < ${anchorRow}`;
  },
  orderBy: (sort: KeysetSort) =>
    sort === 'oldest' ? [asc(target.time), asc(target.id)] : [desc(target.time), desc(target.id)],
});

const compareHistoryText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const memberHistoryIsoDate = (value: Date | string | null): string | null =>
  value instanceof Date ? value.toISOString() : value;

export const listAdminMemberHistory = async (
  userId: string,
  query: AdminMemberHistoryQuery
): Promise<AdminMemberHistoryData | null> => {
  const cursor = decodeCursor(query.cursor);
  const limit = parsePageLimit(query.limit);
  const member = await getAdminMemberProfileIdentity(userId);
  if (!member) return null;

  const { hirerWhere, workerWhere } = memberHistoryFiltersFor(userId, query);

  const [hirerCountRows, workerCountRows, hirerPage, workerPage] = await Promise.all([
    db.select({ total: count() }).from(quest).where(hirerWhere),
    db
      .select({ total: count() })
      .from(questAssignment)
      .innerJoin(quest, eq(quest.id, questAssignment.questId))
      .where(workerWhere),
    readKeysetPage({
      cursorAnchor: memberHistoryCursorAnchorFor(
        'HIRER',
        { time: quest.createdAt, id: quest.id },
        userId,
        query
      ),
      cursor,
      limit,
      where: hirerWhere,
      read: ({ where, orderBy, limit: probe }) =>
        db
          .select({
            id: quest.id,
            createdAt: quest.createdAt,
            questId: quest.id,
            questDisplayId: formatDisplayIdSql('quest', quest.publicSequence),
            questTitle: quest.title,
            questStatus: quest.questStatus,
            questCreatedAt: quest.createdAt,
            questStatusChangedAt: memberHistoryQuestStatusChangedAt(),
            sortCreatedAt: memberHistoryTimestampText(quest.createdAt),
          })
          .from(quest)
          .where(where)
          .orderBy(...orderBy)
          .limit(probe),
      rowCursor: (row) => ({
        startTime: row.createdAt,
        id: row.id,
        scope: memberHistoryCursorScope('HIRER', query),
      }),
      invalidCursor: () =>
        new CursorInputError('INVALID_CURSOR', 'Member history cursor is invalid.'),
    }),
    readKeysetPage({
      cursorAnchor: memberHistoryCursorAnchorFor(
        'WORKER',
        { time: questAssignment.createdAt, id: questAssignment.id },
        userId,
        query
      ),
      cursor,
      limit,
      where: workerWhere,
      read: ({ where, orderBy, limit: probe }) =>
        db
          .select({
            id: questAssignment.id,
            createdAt: questAssignment.createdAt,
            assignmentStatus: questAssignment.assignmentStatus,
            startedAt: questAssignment.startedAt,
            assignmentStatusChangedAt: memberHistoryAssignmentStatusChangedAt(),
            questId: quest.id,
            questDisplayId: formatDisplayIdSql('quest', quest.publicSequence),
            questTitle: quest.title,
            questStatus: quest.questStatus,
            questCreatedAt: quest.createdAt,
            questStatusChangedAt: memberHistoryQuestStatusChangedAt(),
            sortCreatedAt: memberHistoryTimestampText(questAssignment.createdAt),
            hirerId: memberHistoryHirer.id,
            hirerDisplayId: formatDisplayIdSql('member', memberHistoryHirer.publicSequence),
            hirerFirstName: memberHistoryHirer.firstName,
            hirerLastName: memberHistoryHirer.lastName,
          })
          .from(questAssignment)
          .innerJoin(quest, eq(quest.id, questAssignment.questId))
          .innerJoin(memberHistoryHirer, eq(memberHistoryHirer.id, quest.hirerId))
          .where(where)
          .orderBy(...orderBy)
          .limit(probe),
      rowCursor: (row) => ({
        startTime: row.createdAt,
        id: row.id,
        scope: memberHistoryCursorScope('WORKER', query),
      }),
      invalidCursor: () =>
        new CursorInputError('INVALID_CURSOR', 'Member history cursor is invalid.'),
    }),
  ]);

  const pageRows: MemberHistoryPageRow[] = [
    ...hirerPage.rows.map((row) => ({ ...row, role: 'HIRER' as const })),
    ...workerPage.rows.map((row) => ({ ...row, role: 'WORKER' as const })),
  ].sort(
    (left, right) =>
      -1 *
      (compareHistoryText(left.sortCreatedAt, right.sortCreatedAt) ||
        compareHistoryText(left.id, right.id) ||
        compareHistoryText(left.role, right.role))
  );
  const itemsForPage = pageRows.slice(0, limit);
  const last = itemsForPage[itemsForPage.length - 1];
  const hasNext = hirerPage.hasNext || workerPage.hasNext || pageRows.length > limit;
  const hirerQuestIds = itemsForPage
    .filter((row) => row.role === 'HIRER')
    .map((row) => row.questId);
  const relatedWorkerRows =
    hirerQuestIds.length === 0
      ? []
      : await db
          .select({
            questId: questAssignment.questId,
            assignmentStatus: questAssignment.assignmentStatus,
            assignmentCreatedAt: questAssignment.createdAt,
            startedAt: questAssignment.startedAt,
            assignmentStatusChangedAt: memberHistoryAssignmentStatusChangedAt(),
            id: authUser.id,
            displayId: formatDisplayIdSql('member', authUser.publicSequence),
            firstName: authUser.firstName,
            lastName: authUser.lastName,
          })
          .from(questAssignment)
          .innerJoin(quest, eq(quest.id, questAssignment.questId))
          .innerJoin(authUser, eq(authUser.id, questAssignment.workerId))
          .where(
            and(
              inArray(questAssignment.questId, hirerQuestIds),
              query.assignmentStatus
                ? eq(questAssignment.assignmentStatus, query.assignmentStatus)
                : undefined
            )
          )
          .orderBy(asc(questAssignment.createdAt), asc(questAssignment.id));
  const relatedWorkersByQuest = new Map<string, AdminMemberHistoryRelatedMember[]>();
  for (const worker of relatedWorkerRows) {
    const workers = relatedWorkersByQuest.get(worker.questId) ?? [];
    workers.push({
      role: 'WORKER',
      member: {
        id: worker.id,
        displayId: worker.displayId,
        firstName: worker.firstName,
        lastName: worker.lastName,
      },
      assignmentStatus: worker.assignmentStatus as AssignmentStatus,
      assignmentCreatedAt: worker.assignmentCreatedAt.toISOString(),
      startedAt: memberHistoryIsoDate(worker.startedAt),
      assignmentStatusChangedAt: memberHistoryIsoDate(worker.assignmentStatusChangedAt),
    });
    relatedWorkersByQuest.set(worker.questId, workers);
  }

  const items: AdminMemberHistoryItem[] = itemsForPage.map((row) => {
    const questSummary = {
      id: row.questId,
      displayId: row.questDisplayId,
      title: row.questTitle,
      questStatus: row.questStatus as QuestStatus,
      createdAt: row.questCreatedAt.toISOString(),
      questStatusChangedAt: memberHistoryIsoDate(row.questStatusChangedAt),
    };
    if (row.role === 'HIRER') {
      return {
        role: row.role,
        createdAt: row.createdAt.toISOString(),
        assignmentStatus: null,
        startedAt: null,
        assignmentStatusChangedAt: null,
        quest: questSummary,
        relatedMembers: relatedWorkersByQuest.get(row.questId) ?? [],
      };
    }
    return {
      role: row.role,
      createdAt: row.createdAt.toISOString(),
      assignmentStatus: row.assignmentStatus as AssignmentStatus,
      startedAt: memberHistoryIsoDate(row.startedAt),
      assignmentStatusChangedAt: memberHistoryIsoDate(row.assignmentStatusChangedAt),
      quest: questSummary,
      relatedMembers: [
        {
          role: 'HIRER',
          member: {
            id: row.hirerId,
            displayId: row.hirerDisplayId,
            firstName: row.hirerFirstName,
            lastName: row.hirerLastName,
          },
          assignmentStatus: null,
          assignmentCreatedAt: null,
          startedAt: null,
          assignmentStatusChangedAt: null,
        },
      ],
    };
  });

  return {
    member,
    items,
    totalCount: (hirerCountRows[0]?.total ?? 0) + (workerCountRows[0]?.total ?? 0),
    nextCursor:
      hasNext && last
        ? encodeCursor({
            startTime: last.createdAt.toISOString(),
            id: last.id,
            scope: memberHistoryCursorScope(last.role, query),
          })
        : null,
  };
};

export const listAdminMemberReviews = async (
  memberId: string,
  query: AdminMemberReviewsQuery
): Promise<AdminMemberReviewsData | null> => {
  const [member] = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.id, memberId))
    .limit(1);
  if (!member) return null;

  const cursor = decodeCursor(query.cursor);
  const limit = parsePageLimit(query.limit);
  const cursorScope = `MEMBER_REVIEW_${query.rating ?? 'ALL'}`;
  const conditions = [validReceivedReviewFilter(memberId)];
  if (query.rating !== undefined) {
    conditions.push(eq(review.rating, query.rating));
  }
  const where = and(...conditions);
  const page = await readKeysetPage({
    anchor: { time: review.createdAt, id: review.id },
    cursor,
    limit,
    cursorAnchorRead: async (pageCursor) => {
      const [row] = await db
        .select({ startTime: review.createdAt, id: review.id })
        .from(review)
        .innerJoin(quest, eq(review.questId, quest.id))
        .where(and(where, eq(review.id, pageCursor.id)))
        .limit(1);
      return row ? { ...row, scope: cursorScope } : undefined;
    },
    where,
    read: ({ where: pageWhere, orderBy, limit: probe }) =>
      db
        .select({
          id: review.id,
          rating: review.rating,
          comment: review.comment,
          createdAt: review.createdAt,
          updatedAt: review.updatedAt,
          reviewerDisplayId: formatDisplayIdSql('member', authUser.publicSequence),
          reviewerFirstName: authUser.firstName,
          reviewerLastName: authUser.lastName,
          questDisplayId: formatDisplayIdSql('quest', quest.publicSequence),
          questTitle: quest.title,
          questStatus: quest.questStatus,
        })
        .from(review)
        .innerJoin(authUser, eq(review.reviewerId, authUser.id))
        .innerJoin(quest, eq(review.questId, quest.id))
        .where(pageWhere)
        .orderBy(...orderBy)
        .limit(probe),
    rowCursor: (row) => ({
      startTime: row.createdAt,
      id: row.id,
      scope: cursorScope,
    }),
    invalidCursor: () => new CursorInputError('INVALID_CURSOR', 'cursor does not match a Review'),
  });
  const [totalCount] = await db
    .select({ total: count() })
    .from(review)
    .innerJoin(quest, eq(review.questId, quest.id))
    .where(where);

  return {
    items: page.rows.map((row) => ({
      id: row.id,
      rating: row.rating,
      comment: row.comment,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      reviewer: {
        displayId: row.reviewerDisplayId,
        name: `${row.reviewerFirstName} ${row.reviewerLastName}`,
      },
      quest: {
        displayId: row.questDisplayId,
        title: row.questTitle,
        questStatus: row.questStatus,
      },
    })),
    nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
    totalCount: totalCount?.total ?? 0,
  };
};
