import { db } from '@/database/client';
import {
  adminAction,
  adminDisputeCase,
  disputeCaseStatuses,
  type DisputeCaseCategory,
} from '@/database/schema/admin.schema';
import { authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';
import {
  proofSubmission,
  proofSubmissionImage,
  quest,
  questAssignment,
  questV2ProofSubmission,
  questV2ProofSubmissionFile,
} from '@/database/schema/quest.schema';
import {
  formatDisputeDisplayId,
  formatDisplayIdSql,
  formatQuestDisplayId,
  getAdminMemberModerationContext,
} from '@/modules/admin';
import type { AdminMemberModerationContextFields, AdminMemberStatus } from '@/modules/admin';
import {
  createAdminActionService,
  type AdminActionResult,
} from '@/modules/admin/admin-action.service';
import {
  MoneyDomainError,
  positiveSatang,
  settleDisputeCase,
  type WalletTransaction,
} from '@/modules/wallet';
import { CursorInputError, type CursorPayload } from '@/shared/cursor';
import { readKeysetPage } from '@/shared/keyset-page';
import {
  buildStatusCounts,
  containsLikeQueryPattern,
  ilikeContains as adminListSearchValue,
  isoDateSearchText as adminListSearchDate,
} from '@/shared/list-search';

import { and, asc, count, desc, eq, or, sql } from 'drizzle-orm';

import { readQuestEscrow } from '../shared/escrow/quest-escrow.service';
import { notifyQuestUpdate } from '../v2/realtime';
import { questV2ProofStorage } from '../v2/proof/quest-proof-v2.storage';
import {
  disputeAdminActionCatalog,
  type DisputeCaseDismissReasonCode,
  type DisputeCaseResolveReasonCode,
} from './quest-dispute-admin.policy';

const dayMs = 24 * 60 * 60 * 1000;

/** Rulebook: a Hirer or Worker may self-file within 1 day of the Quest failing. */
export const disputeSelfFileWindowMs = dayMs;

/** Tells the filer that their Dispute Case changed; clients refetch the Quest. */
const notifyDisputeCaseUpdated = (
  transaction: WalletTransaction,
  record: Pick<typeof adminDisputeCase.$inferSelect, 'questId' | 'filerUserId' | 'respondentUserId'>
) =>
  notifyQuestUpdate(transaction, {
    questId: record.questId,
    recipientMemberIds: [record.filerUserId, record.respondentUserId].filter(
      (userId): userId is string => userId !== null
    ),
    changeType: 'DISPUTE_CASE_UPDATED',
  });

/** Rulebook: Hirer/Worker self-file within 1 day of failure; Admin on a Worker's behalf within 5. */
const disputeFilingWindowMs = (adminOpened: boolean) =>
  adminOpened ? 5 * dayMs : disputeSelfFileWindowMs;
export type DisputeCaseStatus = (typeof disputeCaseStatuses)[number];
export type DisputeCaseOutcome = 'DISPUTE_CASE_DISMISSED' | 'DISPUTE_CASE_RESOLVED';

const adminActionService = createAdminActionService(disputeAdminActionCatalog);
const maxDisputeEvidenceAssignments = 100;
const maxDisputeEvidenceProofSubmissions = 100;
const maxDisputeEvidenceFiles = 5;

export class AdminDisputeCaseError extends Error {
  readonly code:
    | 'DISPUTE_CASE_NOT_FOUND'
    | 'DISPUTE_CASE_NOT_PENDING'
    | 'DISPUTE_CASE_QUEST_NOT_FAILED'
    | 'DISPUTE_CASE_WORKER_NOT_ASSIGNED'
    | 'DISPUTE_CASE_RESERVATION_NOT_FOUND'
    | 'DISPUTE_CASE_OUTCOME_INVALID'
    | 'DISPUTE_CASE_AMOUNT_REQUIRED'
    | 'DISPUTE_CASE_WINDOW_EXPIRED'
    | 'DISPUTE_CASE_FAILED_AT_UNAVAILABLE'
    | 'DISPUTE_CASE_RESPONDENT_NOT_ALLOWED'
    | 'DISPUTE_CASE_RESPONSE_WINDOW_EXPIRED'
    | 'DISPUTE_CASE_RESPONSE_ALREADY_SUBMITTED';

  constructor(code: AdminDisputeCaseError['code'], message: string) {
    super(message);
    this.name = 'AdminDisputeCaseError';
    this.code = code;
  }
}

export type AdminDisputeCaseSummary = {
  id: string;
  displayId: string;
  questId: string;
  filerUserId: string;
  openedByAdminId: string | null;
  status: DisputeCaseStatus;
  version: number;
  resolvedWorkerId: string | null;
  resolvedAmountSatang: number | null;
  resolvedByAdminId: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AdminDisputeCaseDetail = AdminDisputeCaseSummary &
  AdminMemberModerationContextFields & {
    category: DisputeCaseCategory | null;
    submittedDetail: string | null;
    filerStatement: string | null;
    respondentStatement: string | null;
    filerDisplayId: string | null;
    respondentDisplayId: string | null;
    member: { status: AdminMemberStatus } | null;
    resolvedWorkerDisplayId: string | null;
    decision: {
      reasonCode: string | null;
      decisionReasonText: string | null;
    };
    quest: {
      id: string;
      displayId: string | null;
      title: string;
      hirerId: string;
      hirerDisplayId: string | null;
      questStatus: string;
      version: number;
      failedAt: string | null;
      fundingReservationId: string | null;
    };
  };

export type AdminDisputeEvidence = {
  caseId: string;
  questId: string;
  truncated: boolean;
  quest: {
    id: string;
    questStatus: string;
    version: number;
    hirerId: string;
    failedAt: string | null;
  };
  assignments: Array<{
    id: string;
    workerId: string;
    assignmentStatus: string;
    startedAt: string | null;
    createdAt: string;
  }>;
  proofSubmissions: Array<{
    id: string;
    workerId: string | null;
    teamId: string | null;
    submittedByUserId: string;
    workerMessage: string | null;
    submissionStatus: string;
    submittedAt: string | null;
    files: Array<{
      fileId: string;
      contentType: string;
      sizeBytes: number;
      position: number;
      url: string;
      urlExpiresAt: string;
    }>;
  }>;
};

export type ListAdminDisputeCasesInput = {
  q?: string;
  status?: DisputeCaseStatus;
  limit?: number;
  cursor?: CursorPayload;
  sort?: 'newest' | 'oldest';
};

export type ResolveAdminDisputeCaseInput = {
  adminId: string;
  disputeCaseId: string;
  expectedVersion: number;
  requestKey: string;
  reasonCode: DisputeCaseDismissReasonCode | DisputeCaseResolveReasonCode;
  decisionReasonText?: string;
  outcome: DisputeCaseOutcome;
  workerId?: string;
  amountSatang?: number;
  now?: Date;
};

export type CreateAdminDisputeCaseInput = {
  questId: string;
  filerUserId: string;
  category: DisputeCaseCategory;
  submittedDetail: string;
  filerStatement?: string;
  openedByAdminId?: string;
  now?: Date;
};

export type SubmitDisputeCaseResponseInput = {
  disputeCaseId: string;
  respondentUserId: string;
  respondentStatement: string;
  now?: Date;
};

export type ResolveAdminDisputeCaseResult = AdminActionResult<AdminDisputeCaseSummary> & {
  outcome: DisputeCaseOutcome;
};

const serializeDate = (value: Date | null): string | null => value?.toISOString() ?? null;

export const summaryFromRecord = (
  record: typeof adminDisputeCase.$inferSelect
): AdminDisputeCaseSummary => ({
  id: record.id,
  displayId: formatDisputeDisplayId(record.publicSequence),
  questId: record.questId,
  filerUserId: record.filerUserId,
  openedByAdminId: record.openedByAdminId,
  status: record.status,
  version: record.version,
  resolvedWorkerId: record.resolvedWorkerId,
  resolvedAmountSatang: record.resolvedAmountSatang,
  resolvedByAdminId: record.resolvedByAdminId,
  resolvedAt: serializeDate(record.resolvedAt),
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
});

const caseByIdInTransaction = async (
  transaction: WalletTransaction,
  disputeCaseId: string,
  lock = false
) => {
  const query = transaction
    .select()
    .from(adminDisputeCase)
    .where(eq(adminDisputeCase.id, disputeCaseId));
  const [record] = lock ? await query.for('update') : await query.limit(1);
  return record;
};

/** Create the queue record after a filing adapter has authenticated its actor. */
export const createAdminDisputeCaseInTransaction = async (
  transaction: WalletTransaction,
  input: CreateAdminDisputeCaseInput
) => {
  const now = input.now ?? new Date();
  const [existing] = await transaction
    .select()
    .from(adminDisputeCase)
    .where(
      and(
        eq(adminDisputeCase.questId, input.questId),
        eq(adminDisputeCase.filerUserId, input.filerUserId)
      )
    )
    .for('update');
  if (
    existing &&
    ((existing.category !== null && existing.submittedDetail !== null) ||
      existing.status !== 'DISPUTE_CASE_PENDING')
  )
    return existing;

  const [currentQuest] = await transaction
    .select({
      id: quest.id,
      hirerId: quest.hirerId,
      questStatus: quest.questStatus,
      failedAt: quest.failedAt,
    })
    .from(quest)
    .where(eq(quest.id, input.questId))
    .for('update');
  if (!currentQuest || currentQuest.questStatus !== 'QUEST_FAILED') {
    throw new AdminDisputeCaseError(
      'DISPUTE_CASE_QUEST_NOT_FAILED',
      'Only a failed Quest can receive a Dispute Case.'
    );
  }

  const filingWindow = disputeFilingWindowMs(Boolean(input.openedByAdminId));
  const failedAt = currentQuest.failedAt;
  if (!failedAt) {
    throw new AdminDisputeCaseError(
      'DISPUTE_CASE_FAILED_AT_UNAVAILABLE',
      'The Quest failure time is unavailable.'
    );
  }
  if (now.getTime() > failedAt.getTime() + filingWindow) {
    throw new AdminDisputeCaseError(
      'DISPUTE_CASE_WINDOW_EXPIRED',
      'The Dispute Case filing window has expired.'
    );
  }
  if (input.openedByAdminId && input.filerUserId === currentQuest.hirerId) {
    throw new AdminDisputeCaseError(
      'DISPUTE_CASE_WORKER_NOT_ASSIGNED',
      'An Admin may open a Dispute Case only on behalf of a Worker.'
    );
  }
  if (input.filerUserId !== currentQuest.hirerId) {
    const [assignment] = await transaction
      .select({ id: questAssignment.id })
      .from(questAssignment)
      .where(
        and(
          eq(questAssignment.questId, input.questId),
          eq(questAssignment.workerId, input.filerUserId)
        )
      )
      .limit(1);
    if (!assignment) {
      throw new AdminDisputeCaseError(
        'DISPUTE_CASE_WORKER_NOT_ASSIGNED',
        'The filer did not hold an Assignment on this Quest.'
      );
    }
  }

  const [created] = existing
    ? await transaction
        .update(adminDisputeCase)
        .set({
          category: input.category,
          submittedDetail: input.submittedDetail,
          filerStatement: existing.filerStatement ?? input.filerStatement ?? null,
          openedByAdminId: input.openedByAdminId ?? existing.openedByAdminId,
          version: sql`${adminDisputeCase.version} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(adminDisputeCase.id, existing.id),
            eq(adminDisputeCase.status, 'DISPUTE_CASE_PENDING')
          )
        )
        .returning()
    : await transaction
        .insert(adminDisputeCase)
        .values({
          questId: input.questId,
          filerUserId: input.filerUserId,
          openedByAdminId: input.openedByAdminId,
          category: input.category,
          submittedDetail: input.submittedDetail,
          filerStatement: input.filerStatement ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: [adminDisputeCase.questId, adminDisputeCase.filerUserId],
        })
        .returning();
  if (created) {
    await notifyDisputeCaseUpdated(transaction, created);
    return created;
  }
  const [concurrent] = await transaction
    .select()
    .from(adminDisputeCase)
    .where(
      and(
        eq(adminDisputeCase.questId, input.questId),
        eq(adminDisputeCase.filerUserId, input.filerUserId)
      )
    )
    .limit(1);
  if (!concurrent)
    throw new AdminDisputeCaseError('DISPUTE_CASE_NOT_FOUND', 'Dispute Case could not be created.');
  return concurrent;
};

export const createAdminDisputeCase = async (input: CreateAdminDisputeCaseInput) =>
  db.transaction((transaction) => createAdminDisputeCaseInTransaction(transaction, input));

export const submitDisputeCaseResponse = async ({
  disputeCaseId,
  respondentUserId,
  respondentStatement,
  now = new Date(),
}: SubmitDisputeCaseResponseInput) =>
  db.transaction(async (transaction) => {
    const [row] = await transaction
      .select({
        disputeCase: adminDisputeCase,
        quest: {
          id: quest.id,
          hirerId: quest.hirerId,
          questStatus: quest.questStatus,
          failedAt: quest.failedAt,
        },
      })
      .from(adminDisputeCase)
      .innerJoin(quest, eq(quest.id, adminDisputeCase.questId))
      .where(eq(adminDisputeCase.id, disputeCaseId))
      .for('update');
    if (!row)
      throw new AdminDisputeCaseError('DISPUTE_CASE_NOT_FOUND', 'Dispute Case does not exist.');
    if (row.quest.questStatus !== 'QUEST_FAILED') {
      throw new AdminDisputeCaseError(
        'DISPUTE_CASE_QUEST_NOT_FAILED',
        'A response is only available while the Quest is failed.'
      );
    }
    if (row.disputeCase.status !== 'DISPUTE_CASE_PENDING') {
      throw new AdminDisputeCaseError(
        'DISPUTE_CASE_NOT_PENDING',
        'A response is only available while the Dispute Case is pending.'
      );
    }

    const failedAt = row.quest.failedAt;
    if (!failedAt) {
      throw new AdminDisputeCaseError(
        'DISPUTE_CASE_FAILED_AT_UNAVAILABLE',
        'The Quest failure time is unavailable.'
      );
    }
    if (now.getTime() > failedAt.getTime() + 7 * dayMs) {
      throw new AdminDisputeCaseError(
        'DISPUTE_CASE_RESPONSE_WINDOW_EXPIRED',
        'The Dispute Case response window has expired.'
      );
    }

    let isRespondent = false;
    if (row.disputeCase.filerUserId === row.quest.hirerId) {
      const [assignment] = await transaction
        .select({ id: questAssignment.id })
        .from(questAssignment)
        .where(
          and(
            eq(questAssignment.questId, row.disputeCase.questId),
            eq(questAssignment.workerId, respondentUserId)
          )
        )
        .limit(1);
      isRespondent = assignment !== undefined;
    } else {
      isRespondent = respondentUserId === row.quest.hirerId;
    }
    if (!isRespondent || respondentUserId === row.disputeCase.filerUserId) {
      throw new AdminDisputeCaseError(
        'DISPUTE_CASE_RESPONDENT_NOT_ALLOWED',
        'Only the other Member in this Dispute Case may submit a response.'
      );
    }

    if (row.disputeCase.respondentStatement !== null) {
      if (
        row.disputeCase.respondentUserId === respondentUserId &&
        row.disputeCase.respondentStatement === respondentStatement
      )
        return summaryFromRecord(row.disputeCase);
      throw new AdminDisputeCaseError(
        'DISPUTE_CASE_RESPONSE_ALREADY_SUBMITTED',
        'A respondent statement has already been submitted.'
      );
    }

    const [updated] = await transaction
      .update(adminDisputeCase)
      .set({
        respondentUserId,
        respondentStatement,
        version: sql`${adminDisputeCase.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(adminDisputeCase.id, disputeCaseId),
          eq(adminDisputeCase.status, 'DISPUTE_CASE_PENDING')
        )
      )
      .returning();
    if (!updated) {
      throw new AdminDisputeCaseError(
        'DISPUTE_CASE_NOT_PENDING',
        'Dispute Case changed before the response was submitted.'
      );
    }
    await notifyDisputeCaseUpdated(transaction, updated);
    return summaryFromRecord(updated);
  });

export const listAdminDisputeCases = async ({
  q,
  status = 'DISPUTE_CASE_PENDING',
  limit = 20,
  cursor,
  sort = 'newest',
}: ListAdminDisputeCasesInput = {}) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new CursorInputError('INVALID_LIMIT', 'Dispute Case limit must be between 1 and 50.');
  }

  const searchPattern = containsLikeQueryPattern(q);
  const search = searchPattern
    ? or(
        adminListSearchValue(sql`${adminDisputeCase.id}::text`, searchPattern),
        adminListSearchValue(
          formatDisplayIdSql('dispute', adminDisputeCase.publicSequence),
          searchPattern
        ),
        adminListSearchValue(sql`${adminDisputeCase.questId}::text`, searchPattern),
        adminListSearchValue(sql`${adminDisputeCase.filerUserId}::text`, searchPattern),
        adminListSearchValue(sql`${adminDisputeCase.openedByAdminId}::text`, searchPattern),
        adminListSearchValue(adminDisputeCase.status, searchPattern),
        adminListSearchValue(sql`${adminDisputeCase.version}::text`, searchPattern),
        adminListSearchValue(sql`${adminDisputeCase.resolvedWorkerId}::text`, searchPattern),
        adminListSearchValue(sql`${adminDisputeCase.resolvedAmountSatang}::text`, searchPattern),
        adminListSearchValue(sql`${adminDisputeCase.resolvedByAdminId}::text`, searchPattern),
        adminListSearchValue(adminListSearchDate(adminDisputeCase.resolvedAt), searchPattern),
        adminListSearchValue(adminListSearchDate(adminDisputeCase.createdAt), searchPattern),
        adminListSearchValue(adminListSearchDate(adminDisputeCase.updatedAt), searchPattern)
      )
    : undefined;
  const [page, statusRows] = await Promise.all([
    readKeysetPage({
      anchor: { time: adminDisputeCase.createdAt, id: adminDisputeCase.id },
      cursor,
      limit,
      sort,
      where: and(search, eq(adminDisputeCase.status, status)),
      read: ({ where, orderBy, limit: probe }) =>
        db
          .select()
          .from(adminDisputeCase)
          .where(where)
          .orderBy(...orderBy)
          .limit(probe),
      rowCursor: (row) => ({ startTime: row.createdAt, id: row.id }),
      invalidCursor: () => new CursorInputError('INVALID_CURSOR', 'Dispute cursor is invalid.'),
    }),
    db
      .select({ status: adminDisputeCase.status, count: count() })
      .from(adminDisputeCase)
      .where(search)
      .groupBy(adminDisputeCase.status),
  ]);

  const countsByStatus = buildStatusCounts(disputeCaseStatuses, statusRows);

  return {
    items: page.rows.map(summaryFromRecord),
    nextCursor: page.nextCursor,
    totalCount: countsByStatus[status],
    countsByStatus,
  };
};

export const getAdminDisputeCase = async (
  disputeCaseId: string
): Promise<AdminDisputeCaseDetail> => {
  const [row] = await db
    .select({
      disputeCase: adminDisputeCase,
      caseCreatedAt: sql<string>`to_char(${adminDisputeCase.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      quest: {
        id: quest.id,
        publicSequence: quest.publicSequence,
        title: quest.title,
        hirerId: quest.hirerId,
        questStatus: quest.questStatus,
        version: quest.version,
        failedAt: quest.failedAt,
        fundingReservationId: quest.fundingReservationId,
      },
      filerDisplayId: sql<string | null>`(
        SELECT ${formatDisplayIdSql('member', authUser.publicSequence)}
        FROM ${authUser}
        WHERE ${authUser.id} = ${adminDisputeCase.filerUserId}
        LIMIT 1
      )`,
      respondentDisplayId: sql<string | null>`(
        SELECT ${formatDisplayIdSql('member', authUser.publicSequence)}
        FROM ${authUser}
        WHERE ${authUser.id} = ${adminDisputeCase.respondentUserId}
        LIMIT 1
      )`,
      resolvedWorkerDisplayId: sql<string | null>`(
        SELECT ${formatDisplayIdSql('member', authUser.publicSequence)}
        FROM ${authUser}
        WHERE ${authUser.id} = ${adminDisputeCase.resolvedWorkerId}
        LIMIT 1
      )`,
      hirerDisplayId: sql<string | null>`(
        SELECT ${formatDisplayIdSql('member', authUser.publicSequence)}
        FROM ${authUser}
        WHERE ${authUser.id} = ${quest.hirerId}
        LIMIT 1
      )`,
    })
    .from(adminDisputeCase)
    .innerJoin(quest, eq(quest.id, adminDisputeCase.questId))
    .where(eq(adminDisputeCase.id, disputeCaseId))
    .limit(1);
  if (!row)
    throw new AdminDisputeCaseError('DISPUTE_CASE_NOT_FOUND', 'Dispute Case does not exist.');
  const moderationContext = await getAdminMemberModerationContext(
    row.disputeCase.respondentUserId,
    row.caseCreatedAt
  );
  const [decision] = await db
    .select({
      reasonCode: adminAction.reasonCode,
      decisionReasonText: adminAction.decisionReasonText,
    })
    .from(adminAction)
    .where(
      and(
        eq(adminAction.resourceType, 'dispute_case'),
        eq(adminAction.resourceId, disputeCaseId),
        or(
          eq(adminAction.action, 'DISPUTE_CASE_DISMISS'),
          eq(adminAction.action, 'DISPUTE_CASE_RESOLVE')
        )
      )
    )
    .orderBy(desc(adminAction.createdAt), desc(adminAction.id))
    .limit(1);
  return {
    ...summaryFromRecord(row.disputeCase),
    category: row.disputeCase.category,
    submittedDetail: row.disputeCase.submittedDetail,
    filerStatement: row.disputeCase.filerStatement,
    respondentStatement: row.disputeCase.respondentStatement,
    filerDisplayId: row.filerDisplayId,
    respondentDisplayId: row.respondentDisplayId,
    ...moderationContext,
    member: moderationContext.memberStatus ? { status: moderationContext.memberStatus } : null,
    resolvedWorkerDisplayId: row.resolvedWorkerDisplayId,
    decision: {
      reasonCode: decision?.reasonCode ?? null,
      decisionReasonText: decision?.decisionReasonText ?? null,
    },
    quest: {
      ...row.quest,
      displayId: formatQuestDisplayId(row.quest.publicSequence),
      hirerDisplayId: row.hirerDisplayId,
      failedAt: serializeDate(row.quest.failedAt),
    },
  };
};

const evidenceForCaseInTransaction = async (
  transaction: WalletTransaction,
  disputeCaseId: string
): Promise<AdminDisputeEvidence> => {
  const [caseRow] = await transaction
    .select({
      id: adminDisputeCase.id,
      questId: adminDisputeCase.questId,
    })
    .from(adminDisputeCase)
    .where(eq(adminDisputeCase.id, disputeCaseId))
    .limit(1);
  if (!caseRow)
    throw new AdminDisputeCaseError('DISPUTE_CASE_NOT_FOUND', 'Dispute Case does not exist.');

  const [questRow] = await transaction
    .select({
      id: quest.id,
      questStatus: quest.questStatus,
      version: quest.version,
      hirerId: quest.hirerId,
      failedAt: quest.failedAt,
    })
    .from(quest)
    .where(eq(quest.id, caseRow.questId))
    .limit(1);
  if (!questRow)
    throw new AdminDisputeCaseError('DISPUTE_CASE_NOT_FOUND', 'Dispute Quest does not exist.');

  const assignments = await transaction
    .select({
      id: questAssignment.id,
      workerId: questAssignment.workerId,
      assignmentStatus: questAssignment.assignmentStatus,
      startedAt: questAssignment.startedAt,
      createdAt: questAssignment.createdAt,
    })
    .from(questAssignment)
    .where(eq(questAssignment.questId, caseRow.questId))
    .orderBy(asc(questAssignment.createdAt), asc(questAssignment.id))
    .limit(maxDisputeEvidenceAssignments + 1);
  const assignmentsTruncated = assignments.length > maxDisputeEvidenceAssignments;

  const legacyProofRows = await transaction
    .select({
      id: proofSubmission.id,
      workerId: proofSubmission.workerId,
      teamId: proofSubmission.teamId,
      submittedByUserId: proofSubmission.submittedByUserId,
      workerMessage: sql<string | null>`NULL`,
      submissionStatus: proofSubmission.submissionStatus,
      submittedAt: proofSubmission.submittedAt,
      fileId: proofSubmissionImage.fileId,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      position: proofSubmissionImage.position,
      bucket: file.bucket,
      objectKey: file.objectKey,
    })
    .from(proofSubmission)
    .leftJoin(proofSubmissionImage, eq(proofSubmissionImage.proofSubmissionId, proofSubmission.id))
    .leftJoin(file, eq(file.id, proofSubmissionImage.fileId))
    .where(eq(proofSubmission.questId, caseRow.questId))
    .orderBy(
      asc(proofSubmission.submittedAt),
      asc(proofSubmission.id),
      asc(proofSubmissionImage.position)
    )
    .limit(maxDisputeEvidenceProofSubmissions + 1);
  const v2ProofRows = await transaction
    .select({
      id: questV2ProofSubmission.id,
      workerId: questV2ProofSubmission.workerId,
      teamId: questV2ProofSubmission.teamId,
      submittedByUserId: questV2ProofSubmission.submittedByUserId,
      workerMessage: questV2ProofSubmission.workerMessage,
      submissionStatus: questV2ProofSubmission.submissionStatus,
      submittedAt: questV2ProofSubmission.sentAt,
      fileId: questV2ProofSubmissionFile.fileId,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      position: questV2ProofSubmissionFile.position,
      bucket: file.bucket,
      objectKey: file.objectKey,
    })
    .from(questV2ProofSubmission)
    .leftJoin(
      questV2ProofSubmissionFile,
      eq(questV2ProofSubmissionFile.proofSubmissionId, questV2ProofSubmission.id)
    )
    .leftJoin(file, eq(file.id, questV2ProofSubmissionFile.fileId))
    .where(eq(questV2ProofSubmission.questId, caseRow.questId))
    .orderBy(
      asc(questV2ProofSubmission.sentAt),
      asc(questV2ProofSubmission.id),
      asc(questV2ProofSubmissionFile.position)
    )
    .limit(maxDisputeEvidenceProofSubmissions + 1);

  const proofSubmissions = new Map<string, AdminDisputeEvidence['proofSubmissions'][number]>();
  for (const row of [...legacyProofRows, ...v2ProofRows]) {
    const proof = proofSubmissions.get(row.id) ?? {
      id: row.id,
      workerId: row.workerId,
      teamId: row.teamId,
      submittedByUserId: row.submittedByUserId,
      workerMessage: row.workerMessage,
      submissionStatus: row.submissionStatus ?? 'PROOF_DRAFT',
      submittedAt: serializeDate(row.submittedAt),
      files: [],
    };
    if (
      row.fileId &&
      row.contentType &&
      row.sizeBytes !== null &&
      row.position !== null &&
      row.bucket &&
      row.objectKey
    ) {
      const link = questV2ProofStorage.linkForWithExpiry({
        bucket: row.bucket,
        objectKey: row.objectKey,
      });
      proof.files.push({
        fileId: row.fileId,
        contentType: row.contentType,
        sizeBytes: row.sizeBytes,
        position: row.position,
        url: link.url,
        urlExpiresAt: link.expiresAt.toISOString(),
      });
    }
    proofSubmissions.set(row.id, proof);
  }
  const proofItems = [...proofSubmissions.values()];
  const proofSubmissionsTruncated =
    legacyProofRows.length > maxDisputeEvidenceProofSubmissions ||
    v2ProofRows.length > maxDisputeEvidenceProofSubmissions ||
    proofItems.length > maxDisputeEvidenceProofSubmissions;
  let filesTruncated = false;
  for (const proof of proofItems) {
    if (proof.files.length > maxDisputeEvidenceFiles) filesTruncated = true;
    proof.files = proof.files.slice(0, maxDisputeEvidenceFiles);
  }

  return {
    caseId: caseRow.id,
    questId: caseRow.questId,
    truncated: assignmentsTruncated || proofSubmissionsTruncated || filesTruncated,
    quest: {
      ...questRow,
      questStatus: questRow.questStatus,
      failedAt: serializeDate(questRow.failedAt),
    },
    assignments: assignments.slice(0, maxDisputeEvidenceAssignments).map((assignment) => ({
      ...assignment,
      startedAt: serializeDate(assignment.startedAt),
      createdAt: assignment.createdAt.toISOString(),
    })),
    proofSubmissions: proofItems.slice(0, maxDisputeEvidenceProofSubmissions),
  };
};

export const getAdminDisputeEvidence = async (
  adminId: string,
  disputeCaseId: string,
  requestKey: string
) => {
  const result = await adminActionService.recordEvidenceAccess({
    adminId,
    action: 'DISPUTE_CASE_EVIDENCE_ACCESS',
    resourceType: 'dispute_case',
    resourceId: disputeCaseId,
    requestKey,
    request: { view: 'case-scoped-evidence' },
    metadata: {},
    read: async (transaction) => ({
      resourceSummary: await evidenceForCaseInTransaction(transaction, disputeCaseId),
      resourceVersion: null,
      resourceTimestamp: null,
    }),
  });
  return {
    ...result.resourceSummary,
    adminActionId: result.adminActionId,
  };
};

const summaryResultInTransaction = async (
  transaction: WalletTransaction,
  disputeCaseId: string
): Promise<{
  resourceSummary: AdminDisputeCaseSummary;
  resourceVersion: number;
  resourceTimestamp: null;
}> => {
  const current = await caseByIdInTransaction(transaction, disputeCaseId);
  if (!current)
    throw new AdminDisputeCaseError('DISPUTE_CASE_NOT_FOUND', 'Dispute Case does not exist.');
  return {
    resourceSummary: summaryFromRecord(current),
    resourceVersion: current.version,
    resourceTimestamp: null,
  };
};

const assertResolutionInput = (input: ResolveAdminDisputeCaseInput) => {
  if (input.outcome === 'DISPUTE_CASE_DISMISSED') {
    if (input.workerId !== undefined || input.amountSatang !== undefined) {
      throw new AdminDisputeCaseError(
        'DISPUTE_CASE_OUTCOME_INVALID',
        'Dismissed Dispute Cases cannot include a Worker or an amount.'
      );
    }
    return;
  }
  if (input.outcome !== 'DISPUTE_CASE_RESOLVED') {
    throw new AdminDisputeCaseError(
      'DISPUTE_CASE_OUTCOME_INVALID',
      'Unsupported Dispute Case outcome.'
    );
  }
  if (!input.workerId) {
    throw new AdminDisputeCaseError(
      'DISPUTE_CASE_WORKER_NOT_ASSIGNED',
      'A resolved Dispute Case must name a Worker.'
    );
  }
  if (input.amountSatang === undefined) {
    throw new AdminDisputeCaseError(
      'DISPUTE_CASE_AMOUNT_REQUIRED',
      'A resolved Dispute Case must include a positive Satang amount.'
    );
  }
  try {
    positiveSatang(input.amountSatang);
  } catch (error) {
    if (error instanceof MoneyDomainError) {
      throw new AdminDisputeCaseError('DISPUTE_CASE_AMOUNT_REQUIRED', error.message);
    }
    throw error;
  }
};

export const resolveAdminDisputeCase = async (
  input: ResolveAdminDisputeCaseInput
): Promise<ResolveAdminDisputeCaseResult> => {
  assertResolutionInput(input);
  const now = input.now ?? new Date();
  const action =
    input.outcome === 'DISPUTE_CASE_DISMISSED' ? 'DISPUTE_CASE_DISMISS' : 'DISPUTE_CASE_RESOLVE';
  const result = await adminActionService.executeCommand<AdminDisputeCaseSummary>({
    adminId: input.adminId,
    action,
    resourceType: 'dispute_case',
    resourceId: input.disputeCaseId,
    requestKey: input.requestKey,
    reasonCode: input.reasonCode,
    decisionReasonText: input.decisionReasonText,
    request: {
      outcome: input.outcome,
      workerId: input.workerId ?? null,
      amountSatang: input.amountSatang ?? null,
    },
    metadata: {},
    expectedVersion: input.expectedVersion,
    prepare: async (transaction) => {
      const current = await caseByIdInTransaction(transaction, input.disputeCaseId, true);
      if (!current)
        throw new AdminDisputeCaseError('DISPUTE_CASE_NOT_FOUND', 'Dispute Case does not exist.');

      return {
        currentVersion: current.version,
        apply: async () => {
          if (current.status !== 'DISPUTE_CASE_PENDING') {
            throw new AdminDisputeCaseError(
              'DISPUTE_CASE_NOT_PENDING',
              'Dispute Case has already reached a terminal status.'
            );
          }
          const [currentQuest] = await transaction
            .select({
              id: quest.id,
              hirerId: quest.hirerId,
              questStatus: quest.questStatus,
              failedAt: quest.failedAt,
              updatedAt: quest.updatedAt,
              fundingReservationId: quest.fundingReservationId,
            })
            .from(quest)
            .where(eq(quest.id, current.questId))
            .for('update');
          if (!currentQuest || currentQuest.questStatus !== 'QUEST_FAILED') {
            throw new AdminDisputeCaseError(
              'DISPUTE_CASE_QUEST_NOT_FAILED',
              'Only a failed Quest can have a Dispute Case resolved.'
            );
          }
          const failedAt = currentQuest.failedAt ?? currentQuest.updatedAt;
          const filingWindow = disputeFilingWindowMs(Boolean(current.openedByAdminId));
          if (current.createdAt.getTime() > failedAt.getTime() + filingWindow) {
            throw new AdminDisputeCaseError(
              'DISPUTE_CASE_WINDOW_EXPIRED',
              'Dispute Case was opened after its allowed filing window.'
            );
          }

          if (input.outcome === 'DISPUTE_CASE_DISMISSED') {
            const [updated] = await transaction
              .update(adminDisputeCase)
              .set({
                status: 'DISPUTE_CASE_DISMISSED',
                resolvedByAdminId: input.adminId,
                resolvedAt: now,
                version: sql`${adminDisputeCase.version} + 1`,
                updatedAt: now,
              })
              .where(
                and(
                  eq(adminDisputeCase.id, current.id),
                  eq(adminDisputeCase.version, input.expectedVersion),
                  eq(adminDisputeCase.status, 'DISPUTE_CASE_PENDING')
                )
              )
              .returning();
            if (!updated)
              throw new AdminDisputeCaseError(
                'DISPUTE_CASE_NOT_PENDING',
                'Dispute Case changed before dismissal.'
              );
            await notifyDisputeCaseUpdated(transaction, updated);
            return summaryResultInTransaction(transaction, updated.id);
          }

          const [assignment] = await transaction
            .select({ id: questAssignment.id })
            .from(questAssignment)
            .where(
              and(
                eq(questAssignment.questId, current.questId),
                eq(questAssignment.workerId, input.workerId!)
              )
            )
            .limit(1);
          if (!assignment) {
            throw new AdminDisputeCaseError(
              'DISPUTE_CASE_WORKER_NOT_ASSIGNED',
              'The named Worker did not hold an Assignment on this Quest.'
            );
          }
          if (!currentQuest.fundingReservationId) {
            throw new AdminDisputeCaseError(
              'DISPUTE_CASE_RESERVATION_NOT_FOUND',
              'The failed Quest has no Funding Reservation.'
            );
          }

          const settlement = await settleDisputeCase(transaction, {
            ownerUserId: currentQuest.hirerId,
            reservationId: currentQuest.fundingReservationId,
            settlementReference: `dispute-case:${current.id}`,
            recipientUserId: input.workerId!,
            requestedAmountSatang: positiveSatang(input.amountSatang!),
          });
          const [updated] = await transaction
            .update(adminDisputeCase)
            .set({
              status: 'DISPUTE_CASE_RESOLVED',
              resolvedWorkerId: input.workerId,
              resolvedAmountSatang: settlement.recipientAmountSatang,
              resolvedByAdminId: input.adminId,
              resolvedAt: now,
              version: sql`${adminDisputeCase.version} + 1`,
              updatedAt: now,
            })
            .where(
              and(
                eq(adminDisputeCase.id, current.id),
                eq(adminDisputeCase.version, input.expectedVersion),
                eq(adminDisputeCase.status, 'DISPUTE_CASE_PENDING')
              )
            )
            .returning();
          if (!updated)
            throw new AdminDisputeCaseError(
              'DISPUTE_CASE_NOT_PENDING',
              'Dispute Case changed before resolution.'
            );
          await notifyDisputeCaseUpdated(transaction, updated);
          return summaryResultInTransaction(transaction, updated.id);
        },
      };
    },
  });
  return { ...result, outcome: input.outcome };
};

export type QuestDisputeSummary = {
  canFile: boolean;
  windowEndsAt: Date | null;
  myCase: { id: string; displayId: string; status: DisputeCaseStatus; createdAt: Date } | null;
};

/**
 * The viewer's Dispute view of a Quest. Null unless the Quest is `QUEST_FAILED`.
 * `canFile` and `windowEndsAt` follow the self-file window used by `createAdminDisputeCase`.
 */
export const readQuestDisputeSummary = async (
  viewerId: string,
  questId: string,
  now = new Date()
): Promise<QuestDisputeSummary | null> => {
  const [row] = await db
    .select({
      hirerId: quest.hirerId,
      questStatus: quest.questStatus,
      failedAt: quest.failedAt,
      updatedAt: quest.updatedAt,
    })
    .from(quest)
    .where(eq(quest.id, questId))
    .limit(1);
  if (!row || row.questStatus !== 'QUEST_FAILED') return null;

  const [existing] = await db
    .select()
    .from(adminDisputeCase)
    .where(and(eq(adminDisputeCase.questId, questId), eq(adminDisputeCase.filerUserId, viewerId)))
    .limit(1);
  const [assignment] =
    viewerId === row.hirerId
      ? [undefined]
      : await db
          .select({ id: questAssignment.id })
          .from(questAssignment)
          .where(and(eq(questAssignment.questId, questId), eq(questAssignment.workerId, viewerId)))
          .limit(1);
  const endsAt = new Date((row.failedAt ?? row.updatedAt).getTime() + disputeFilingWindowMs(false));
  const open = now.getTime() <= endsAt.getTime();
  return {
    canFile: open && !existing && (viewerId === row.hirerId || assignment !== undefined),
    windowEndsAt: open ? endsAt : null,
    myCase: existing
      ? {
          id: existing.id,
          displayId: formatDisputeDisplayId(existing.publicSequence),
          status: existing.status,
          createdAt: existing.createdAt,
        }
      : null,
  };
};

export type QuestMoneyHold = {
  status: 'HELD' | 'RELEASED';
  releasesAt: Date;
  /** Satang still held in the Hirer's Funding Reservation; null for a Worker viewer. */
  heldSatang: number | null;
};

/**
 * The 7-day hold on a failed Quest. It ends at `failedAt + 7 days` and a Dispute Case does not
 * move that instant (Admin Rulebook), so `releasesAt` stays the nominal time even if the
 * lifecycle worker runs late. Null unless the Quest is `QUEST_FAILED`.
 */
export const readQuestMoneyHold = async (
  viewerId: string,
  questId: string
): Promise<QuestMoneyHold | null> => {
  const [row] = await db
    .select({
      hirerId: quest.hirerId,
      questStatus: quest.questStatus,
      failedAt: quest.failedAt,
      updatedAt: quest.updatedAt,
    })
    .from(quest)
    .where(eq(quest.id, questId))
    .limit(1);
  if (!row || row.questStatus !== 'QUEST_FAILED') return null;
  const releasesAt = new Date((row.failedAt ?? row.updatedAt).getTime() + 7 * dayMs);
  const escrow = await db.transaction((transaction) =>
    readQuestEscrow(transaction, { ownerUserId: row.hirerId, questId })
  );
  const held = escrow?.status === 'ACTIVE';
  return {
    status: held ? 'HELD' : 'RELEASED',
    releasesAt,
    heldSatang: viewerId === row.hirerId ? (held ? escrow.remainingSatang : 0) : null,
  };
};
