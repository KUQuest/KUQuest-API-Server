import { db } from '@/database/client';
import { adminDisputeCase, disputeCaseStatuses } from '@/database/schema/admin.schema';
import { proofSubmission, proofSubmissionImage, quest, questAssignment, questV2ProofSubmission, questV2ProofSubmissionFile } from '@/database/schema/quest.schema';
import { file } from '@/database/schema/file.schema';
import {
  createAdminActionService,
  type AdminActionReasonCatalog,
  type AdminActionResult,
} from '@/modules/admin';
import {
  MoneyDomainError,
  positiveSatang,
  settleDisputeCase,
  type WalletTransaction,
} from '@/modules/wallet';
import { CursorInputError, type CursorPayload } from '@/shared/cursor';

import { and, asc, desc, eq, gt, lt, or, sql } from 'drizzle-orm';

export type DisputeCaseStatus = (typeof disputeCaseStatuses)[number];
export type DisputeCaseOutcome = 'DISPUTE_CASE_DISMISSED' | 'DISPUTE_CASE_RESOLVED';

export const disputeAdminReasonCodes = [
  'DISPUTE_POLICY_REVIEW',
  'DISPUTE_EVIDENCE_REVIEW',
] as const;

export const disputeAdminActionCatalog: AdminActionReasonCatalog = {
  version: 1,
  actions: {
    DISPUTE_CASE_DISMISS: {
      kind: 'COMMAND',
      requiresReason: true,
      allowedReasonCodes: disputeAdminReasonCodes,
    },
    DISPUTE_CASE_RESOLVE: {
      kind: 'COMMAND',
      requiresReason: true,
      allowedReasonCodes: disputeAdminReasonCodes,
    },
    DISPUTE_CASE_EVIDENCE_ACCESS: {
      kind: 'EVIDENCE_ACCESS',
      requiresReason: false,
      allowedReasonCodes: [],
    },
  },
};

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
    | 'DISPUTE_CASE_WINDOW_EXPIRED';

  constructor(
    code: AdminDisputeCaseError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'AdminDisputeCaseError';
    this.code = code;
  }
}

export type AdminDisputeCaseSummary = {
  id: string;
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

export type AdminDisputeCaseDetail = AdminDisputeCaseSummary & {
  quest: {
    id: string;
    title: string;
    hirerId: string;
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
    submissionStatus: string;
    submittedAt: string | null;
    files: Array<{
      fileId: string;
      contentType: string;
      sizeBytes: number;
      position: number;
    }>;
  }>;
};

export type ListAdminDisputeCasesInput = {
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
  reasonCode?: string;
  outcome: DisputeCaseOutcome;
  workerId?: string;
  amountSatang?: number;
  now?: Date;
};

export type CreateAdminDisputeCaseInput = {
  questId: string;
  filerUserId: string;
  openedByAdminId?: string;
  now?: Date;
};

export type ResolveAdminDisputeCaseResult = AdminActionResult<AdminDisputeCaseSummary> & {
  outcome: DisputeCaseOutcome;
};

const serializeDate = (value: Date | null): string | null => value?.toISOString() ?? null;

export const summaryFromRecord = (
  record: typeof adminDisputeCase.$inferSelect,
): AdminDisputeCaseSummary => ({
  id: record.id,
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
  lock = false,
) => {
  const query = transaction
    .select()
    .from(adminDisputeCase)
    .where(eq(adminDisputeCase.id, disputeCaseId));
  const [record] = lock ? await query.for('update') : await query.limit(1);
  return record;
};

const listCursorCondition = (
  cursor: CursorPayload | undefined,
  sort: 'newest' | 'oldest',
) => {
  if (!cursor) return undefined;
  const cursorDate = new Date(cursor.startTime);
  if (Number.isNaN(cursorDate.getTime())) {
    throw new CursorInputError('INVALID_CURSOR', 'Dispute cursor is invalid.');
  }
  return sort === 'oldest'
    ? or(
      gt(adminDisputeCase.createdAt, cursorDate),
      and(eq(adminDisputeCase.createdAt, cursorDate), gt(adminDisputeCase.id, cursor.id)),
    )
    : or(
      lt(adminDisputeCase.createdAt, cursorDate),
      and(eq(adminDisputeCase.createdAt, cursorDate), lt(adminDisputeCase.id, cursor.id)),
    );
};

/** Create the queue record after a filing adapter has authenticated its actor. */
export const createAdminDisputeCaseInTransaction = async (
  transaction: WalletTransaction,
  input: CreateAdminDisputeCaseInput,
) => {
  const now = input.now ?? new Date();
  const [existing] = await transaction
    .select()
    .from(adminDisputeCase)
    .where(and(
      eq(adminDisputeCase.questId, input.questId),
      eq(adminDisputeCase.filerUserId, input.filerUserId),
    ))
    .limit(1);
  if (existing) return existing;

  const [currentQuest] = await transaction
    .select({
      id: quest.id,
      hirerId: quest.hirerId,
      questStatus: quest.questStatus,
      failedAt: quest.failedAt,
      updatedAt: quest.updatedAt,
    })
    .from(quest)
    .where(eq(quest.id, input.questId))
    .for('update');
  if (!currentQuest || currentQuest.questStatus !== 'QUEST_FAILED') {
    throw new AdminDisputeCaseError('DISPUTE_CASE_QUEST_NOT_FAILED', 'Only a failed Quest can receive a Dispute Case.');
  }

  const filingWindow = input.openedByAdminId ? 5 : 1;
  const failedAt = currentQuest.failedAt ?? currentQuest.updatedAt;
  if (now.getTime() > failedAt.getTime() + filingWindow * 24 * 60 * 60 * 1000) {
    throw new AdminDisputeCaseError('DISPUTE_CASE_WINDOW_EXPIRED', 'The Dispute Case filing window has expired.');
  }
  if (input.openedByAdminId && input.filerUserId === currentQuest.hirerId) {
    throw new AdminDisputeCaseError('DISPUTE_CASE_WORKER_NOT_ASSIGNED', 'An Admin may open a Dispute Case only on behalf of a Worker.');
  }
  if (input.filerUserId !== currentQuest.hirerId) {
    const [assignment] = await transaction
      .select({ id: questAssignment.id })
      .from(questAssignment)
      .where(and(
        eq(questAssignment.questId, input.questId),
        eq(questAssignment.workerId, input.filerUserId),
      ))
      .limit(1);
    if (!assignment) {
      throw new AdminDisputeCaseError('DISPUTE_CASE_WORKER_NOT_ASSIGNED', 'The filer did not hold an Assignment on this Quest.');
    }
  }

  const [created] = await transaction
    .insert(adminDisputeCase)
    .values({
      questId: input.questId,
      filerUserId: input.filerUserId,
      openedByAdminId: input.openedByAdminId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: [adminDisputeCase.questId, adminDisputeCase.filerUserId],
    })
    .returning();
  if (created) return created;
  const [concurrent] = await transaction
    .select()
    .from(adminDisputeCase)
    .where(and(
      eq(adminDisputeCase.questId, input.questId),
      eq(adminDisputeCase.filerUserId, input.filerUserId),
    ))
    .limit(1);
  if (!concurrent) throw new AdminDisputeCaseError('DISPUTE_CASE_NOT_FOUND', 'Dispute Case could not be created.');
  return concurrent;
};

export const createAdminDisputeCase = async (input: CreateAdminDisputeCaseInput) =>
  db.transaction((transaction) => createAdminDisputeCaseInTransaction(transaction, input));

export const listAdminDisputeCases = async ({
  status = 'DISPUTE_CASE_PENDING',
  limit = 20,
  cursor,
  sort = 'newest',
}: ListAdminDisputeCasesInput = {}) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new CursorInputError('INVALID_LIMIT', 'Dispute Case limit must be between 1 and 50.');
  }
  const rows = await db
    .select()
    .from(adminDisputeCase)
    .where(and(
      eq(adminDisputeCase.status, status),
      listCursorCondition(cursor, sort),
    ))
    .orderBy(
      sort === 'oldest' ? asc(adminDisputeCase.createdAt) : desc(adminDisputeCase.createdAt),
      sort === 'oldest' ? asc(adminDisputeCase.id) : desc(adminDisputeCase.id),
    )
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(summaryFromRecord),
    nextCursor: rows.length > limit && last
      ? { startTime: last.createdAt.toISOString(), id: last.id }
      : null,
  };
};

export const getAdminDisputeCase = async (
  disputeCaseId: string,
): Promise<AdminDisputeCaseDetail> => {
  const [row] = await db
    .select({
      disputeCase: adminDisputeCase,
      quest: {
        id: quest.id,
        title: quest.title,
        hirerId: quest.hirerId,
        questStatus: quest.questStatus,
        version: quest.version,
        failedAt: quest.failedAt,
        fundingReservationId: quest.fundingReservationId,
      },
    })
    .from(adminDisputeCase)
    .innerJoin(quest, eq(quest.id, adminDisputeCase.questId))
    .where(eq(adminDisputeCase.id, disputeCaseId))
    .limit(1);
  if (!row) throw new AdminDisputeCaseError('DISPUTE_CASE_NOT_FOUND', 'Dispute Case does not exist.');
  return {
    ...summaryFromRecord(row.disputeCase),
    quest: {
      ...row.quest,
      failedAt: serializeDate(row.quest.failedAt),
    },
  };
};

const evidenceForCaseInTransaction = async (
  transaction: WalletTransaction,
  disputeCaseId: string,
): Promise<AdminDisputeEvidence> => {
  const [caseRow] = await transaction
    .select({
      id: adminDisputeCase.id,
      questId: adminDisputeCase.questId,
    })
    .from(adminDisputeCase)
    .where(eq(adminDisputeCase.id, disputeCaseId))
    .limit(1);
  if (!caseRow) throw new AdminDisputeCaseError('DISPUTE_CASE_NOT_FOUND', 'Dispute Case does not exist.');

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
  if (!questRow) throw new AdminDisputeCaseError('DISPUTE_CASE_NOT_FOUND', 'Dispute Quest does not exist.');

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
      submissionStatus: proofSubmission.submissionStatus,
      submittedAt: proofSubmission.submittedAt,
      fileId: proofSubmissionImage.fileId,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      position: proofSubmissionImage.position,
    })
    .from(proofSubmission)
    .leftJoin(proofSubmissionImage, eq(proofSubmissionImage.proofSubmissionId, proofSubmission.id))
    .leftJoin(file, eq(file.id, proofSubmissionImage.fileId))
    .where(eq(proofSubmission.questId, caseRow.questId))
    .orderBy(asc(proofSubmission.submittedAt), asc(proofSubmission.id), asc(proofSubmissionImage.position))
    .limit(maxDisputeEvidenceProofSubmissions + 1);
  const v2ProofRows = await transaction
    .select({
      id: questV2ProofSubmission.id,
      workerId: questV2ProofSubmission.workerId,
      teamId: questV2ProofSubmission.teamId,
      submittedByUserId: questV2ProofSubmission.submittedByUserId,
      submissionStatus: questV2ProofSubmission.submissionStatus,
      submittedAt: questV2ProofSubmission.sentAt,
      fileId: questV2ProofSubmissionFile.fileId,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      position: questV2ProofSubmissionFile.position,
    })
    .from(questV2ProofSubmission)
    .leftJoin(questV2ProofSubmissionFile, eq(questV2ProofSubmissionFile.proofSubmissionId, questV2ProofSubmission.id))
    .leftJoin(file, eq(file.id, questV2ProofSubmissionFile.fileId))
    .where(eq(questV2ProofSubmission.questId, caseRow.questId))
    .orderBy(asc(questV2ProofSubmission.sentAt), asc(questV2ProofSubmission.id), asc(questV2ProofSubmissionFile.position))
    .limit(maxDisputeEvidenceProofSubmissions + 1);

  const proofSubmissions = new Map<string, AdminDisputeEvidence['proofSubmissions'][number]>();
  for (const row of [...legacyProofRows, ...v2ProofRows]) {
    const proof = proofSubmissions.get(row.id) ?? {
      id: row.id,
      workerId: row.workerId,
      teamId: row.teamId,
      submittedByUserId: row.submittedByUserId,
      submissionStatus: row.submissionStatus ?? 'PROOF_DRAFT',
      submittedAt: serializeDate(row.submittedAt),
      files: [],
    };
    if (row.fileId && row.contentType && row.sizeBytes !== null && row.position !== null) {
      proof.files.push({
        fileId: row.fileId,
        contentType: row.contentType,
        sizeBytes: row.sizeBytes,
        position: row.position,
      });
    }
    proofSubmissions.set(row.id, proof);
  }
  const proofItems = [...proofSubmissions.values()];
  const proofSubmissionsTruncated = legacyProofRows.length > maxDisputeEvidenceProofSubmissions ||
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
  requestKey: string,
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
  disputeCaseId: string,
): Promise<{
  resourceSummary: AdminDisputeCaseSummary;
  resourceVersion: number;
  resourceTimestamp: null;
}> => {
  const current = await caseByIdInTransaction(transaction, disputeCaseId);
  if (!current) throw new AdminDisputeCaseError('DISPUTE_CASE_NOT_FOUND', 'Dispute Case does not exist.');
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
        'Dismissed Dispute Cases cannot include a Worker or an amount.',
      );
    }
    return;
  }
  if (input.outcome !== 'DISPUTE_CASE_RESOLVED') {
    throw new AdminDisputeCaseError('DISPUTE_CASE_OUTCOME_INVALID', 'Unsupported Dispute Case outcome.');
  }
  if (!input.workerId) {
    throw new AdminDisputeCaseError('DISPUTE_CASE_WORKER_NOT_ASSIGNED', 'A resolved Dispute Case must name a Worker.');
  }
  if (input.amountSatang === undefined) {
    throw new AdminDisputeCaseError('DISPUTE_CASE_AMOUNT_REQUIRED', 'A resolved Dispute Case must include a positive Satang amount.');
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
  input: ResolveAdminDisputeCaseInput,
): Promise<ResolveAdminDisputeCaseResult> => {
  assertResolutionInput(input);
  const now = input.now ?? new Date();
  const action = input.outcome === 'DISPUTE_CASE_DISMISSED'
    ? 'DISPUTE_CASE_DISMISS'
    : 'DISPUTE_CASE_RESOLVE';
  const result = await adminActionService.executeCommand<AdminDisputeCaseSummary>({
    adminId: input.adminId,
    action,
    resourceType: 'dispute_case',
    resourceId: input.disputeCaseId,
    requestKey: input.requestKey,
    reasonCode: input.reasonCode,
    request: {
      outcome: input.outcome,
      workerId: input.workerId ?? null,
      amountSatang: input.amountSatang ?? null,
    },
    metadata: {},
    expectedVersion: input.expectedVersion,
    prepare: async (transaction) => {
      const current = await caseByIdInTransaction(transaction, input.disputeCaseId, true);
      if (!current) throw new AdminDisputeCaseError('DISPUTE_CASE_NOT_FOUND', 'Dispute Case does not exist.');

      return {
        currentVersion: current.version,
        apply: async () => {
          if (current.status !== 'DISPUTE_CASE_PENDING') {
            throw new AdminDisputeCaseError('DISPUTE_CASE_NOT_PENDING', 'Dispute Case has already reached a terminal status.');
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
            throw new AdminDisputeCaseError('DISPUTE_CASE_QUEST_NOT_FAILED', 'Only a failed Quest can have a Dispute Case resolved.');
          }
          const failedAt = currentQuest.failedAt ?? currentQuest.updatedAt;
          const filingWindow = current.openedByAdminId ? 5 : 1;
          if (current.createdAt.getTime() > failedAt.getTime() + filingWindow * 24 * 60 * 60 * 1000) {
            throw new AdminDisputeCaseError('DISPUTE_CASE_WINDOW_EXPIRED', 'Dispute Case was opened after its allowed filing window.');
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
              .where(and(
                eq(adminDisputeCase.id, current.id),
                eq(adminDisputeCase.version, input.expectedVersion),
                eq(adminDisputeCase.status, 'DISPUTE_CASE_PENDING'),
              ))
              .returning();
            if (!updated) throw new AdminDisputeCaseError('DISPUTE_CASE_NOT_PENDING', 'Dispute Case changed before dismissal.');
            return summaryResultInTransaction(transaction, updated.id);
          }

          const [assignment] = await transaction
            .select({ id: questAssignment.id })
            .from(questAssignment)
            .where(and(
              eq(questAssignment.questId, current.questId),
              eq(questAssignment.workerId, input.workerId!),
            ))
            .limit(1);
          if (!assignment) {
            throw new AdminDisputeCaseError('DISPUTE_CASE_WORKER_NOT_ASSIGNED', 'The named Worker did not hold an Assignment on this Quest.');
          }
          if (!currentQuest.fundingReservationId) {
            throw new AdminDisputeCaseError('DISPUTE_CASE_RESERVATION_NOT_FOUND', 'The failed Quest has no Funding Reservation.');
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
            .where(and(
              eq(adminDisputeCase.id, current.id),
              eq(adminDisputeCase.version, input.expectedVersion),
              eq(adminDisputeCase.status, 'DISPUTE_CASE_PENDING'),
            ))
            .returning();
          if (!updated) throw new AdminDisputeCaseError('DISPUTE_CASE_NOT_PENDING', 'Dispute Case changed before resolution.');
          return summaryResultInTransaction(transaction, updated.id);
        },
      };
    },
  });
  return { ...result, outcome: input.outcome };
};
