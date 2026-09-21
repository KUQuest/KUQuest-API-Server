import { db } from '@/database/client';
import {
  adminEvidenceReference,
  adminModerationDecision,
  adminReportCase,
  adminReporterEntry,
  reportCaseStatus,
  type ReportCaseStatus,
} from '@/database/schema/admin.schema';
import { authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';
import {
  chatAttachment,
  chatConversation,
  chatMembership,
  chatMessage,
  chatMessageAttachment,
} from '@/database/schema/work-chat.schema';
import { CursorInputError, type CursorPayload } from '@/shared/cursor';
import { readKeysetPage } from '@/shared/keyset-page';
import { workChatStorage } from '@/modules/work-chat';

import { and, asc, count, desc, eq, exists, gt, inArray, isNull, lt, sql } from 'drizzle-orm';

import type {
  AdminReportCommandData,
  AdminReportEvidenceData,
  AdminReportListData,
} from './admin-report.schema';
import {
  createAdminActionService,
  type AdminActionResult,
  type AdminActionTransaction,
} from './admin-action.service';
import type { AdminActionReasonCatalog } from './admin-action.policy';
import { formatReportCaseDisplayId } from './admin-display-id';

export type ReportCaseOutcome =
  'REPORT_CASE_DISMISSED' | 'REPORT_CASE_HIDDEN' | 'REPORT_CASE_RESTORED';

export const reportAdminReasonCodes = ['POLICY_REVIEW', 'SAFETY_REVIEW'] as const;

export const reportAdminActionCatalog: AdminActionReasonCatalog = {
  version: 1,
  actions: {
    REPORT_CASE_DISMISS: {
      kind: 'COMMAND',
      requiresReason: true,
      allowedReasonCodes: reportAdminReasonCodes,
    },
    REPORT_CASE_HIDE: {
      kind: 'COMMAND',
      requiresReason: true,
      allowedReasonCodes: reportAdminReasonCodes,
    },
    REPORT_CASE_RESTORE: {
      kind: 'COMMAND',
      requiresReason: true,
      allowedReasonCodes: reportAdminReasonCodes,
    },
    REPORT_CASE_EVIDENCE_ACCESS: {
      kind: 'EVIDENCE_ACCESS',
      requiresReason: false,
      allowedReasonCodes: [],
    },
  },
};

const adminActionService = createAdminActionService(reportAdminActionCatalog);
const maxEvidenceContextMessages = 3;
const evidenceProbeLimit = maxEvidenceContextMessages + 1;

export class AdminReportCaseError extends Error {
  readonly code:
    'REPORT_CASE_NOT_FOUND' | 'REPORT_CASE_OUTCOME_INVALID' | 'REPORT_EVIDENCE_NOT_FOUND';

  constructor(code: AdminReportCaseError['code'], message: string) {
    super(message);
    this.name = 'AdminReportCaseError';
    this.code = code;
  }
}

type ReportCaseRecord = typeof adminReportCase.$inferSelect;
type ReportDatabase = typeof db | AdminActionTransaction;

type ReportCaseListRow = {
  reportCase: ReportCaseRecord;
  conversationId: string;
  questId: string;
};

type ReporterRow = {
  id: string;
  reportCaseId: string;
  reporterMemberId: string;
  reason: string;
  detail: string | null;
  createdAt: Date;
  reporterId: string;
  reporterEmail: string;
  reporterFirstName: string;
  reporterLastName: string;
};

type EvidenceReferenceRow = {
  id: string;
  reportCaseId: string;
  messageId: string | null;
  attachmentId: string | null;
  createdAt: Date;
};

type ReportCaseSummary = AdminReportListData['items'][number];
type ReportCaseCommandSummary = AdminReportCommandData['resourceSummary'];
type AdminReportEvidence = Omit<AdminReportEvidenceData, 'adminActionId'>;

const serializeDate = (value: Date | null): string | null => value?.toISOString() ?? null;

const displayIdFrom = (record: ReportCaseRecord): string =>
  formatReportCaseDisplayId(record.publicSequence);

const reporterRowsFor = async (
  database: ReportDatabase,
  reportCaseIds: string[]
): Promise<ReporterRow[]> => {
  if (reportCaseIds.length === 0) return [];

  return database
    .select({
      id: adminReporterEntry.id,
      reportCaseId: adminReporterEntry.reportCaseId,
      reporterMemberId: adminReporterEntry.reporterMemberId,
      reason: adminReporterEntry.reason,
      detail: adminReporterEntry.detail,
      createdAt: adminReporterEntry.createdAt,
      reporterId: authUser.id,
      reporterEmail: authUser.email,
      reporterFirstName: authUser.firstName,
      reporterLastName: authUser.lastName,
    })
    .from(adminReporterEntry)
    .innerJoin(authUser, eq(authUser.id, adminReporterEntry.reporterMemberId))
    .where(inArray(adminReporterEntry.reportCaseId, reportCaseIds))
    .orderBy(asc(adminReporterEntry.createdAt), asc(adminReporterEntry.id));
};

const evidenceReferenceRowsFor = async (
  database: ReportDatabase,
  reportCaseIds: string[]
): Promise<EvidenceReferenceRow[]> => {
  if (reportCaseIds.length === 0) return [];

  return database
    .select({
      id: adminEvidenceReference.id,
      reportCaseId: adminEvidenceReference.reportCaseId,
      messageId: adminEvidenceReference.messageId,
      attachmentId: adminEvidenceReference.attachmentId,
      createdAt: adminEvidenceReference.createdAt,
    })
    .from(adminEvidenceReference)
    .where(inArray(adminEvidenceReference.reportCaseId, reportCaseIds))
    .orderBy(asc(adminEvidenceReference.createdAt), asc(adminEvidenceReference.id));
};

const summaryFrom = (
  row: ReportCaseListRow,
  reporterRows: ReporterRow[],
  referenceRows: EvidenceReferenceRow[]
): ReportCaseSummary => ({
  kind: 'REPORT_CASE',
  id: row.reportCase.id,
  displayId: displayIdFrom(row.reportCase),
  messageId: row.reportCase.messageId,
  conversationId: row.conversationId,
  questId: row.questId,
  status: row.reportCase.status,
  version: row.reportCase.version,
  caseClosedAt: serializeDate(row.reportCase.caseClosedAt),
  createdAt: row.reportCase.createdAt.toISOString(),
  updatedAt: row.reportCase.updatedAt.toISOString(),
  reporterEntries: reporterRows
    .filter((entry) => entry.reportCaseId === row.reportCase.id)
    .map((entry) => ({
      id: entry.id,
      reporterMemberId: entry.reporterMemberId,
      reporter: {
        id: entry.reporterId,
        email: entry.reporterEmail,
        firstName: entry.reporterFirstName,
        lastName: entry.reporterLastName,
      },
      reason: entry.reason as ReportCaseSummary['reporterEntries'][number]['reason'],
      detail: entry.detail,
      createdAt: entry.createdAt.toISOString(),
    })),
  evidenceReferences: referenceRows
    .filter((reference) => reference.reportCaseId === row.reportCase.id)
    .map((reference) => ({
      id: reference.id,
      messageId: reference.messageId,
      attachmentId: reference.attachmentId,
      createdAt: reference.createdAt.toISOString(),
    })),
});

const commandSummaryInTransaction = async (
  database: ReportDatabase,
  record: ReportCaseRecord
): Promise<ReportCaseCommandSummary> => {
  const [entryCount, referenceCount] = await Promise.all([
    database
      .select({ total: count() })
      .from(adminReporterEntry)
      .where(eq(adminReporterEntry.reportCaseId, record.id)),
    database
      .select({ total: count() })
      .from(adminEvidenceReference)
      .where(eq(adminEvidenceReference.reportCaseId, record.id)),
  ]);

  return {
    id: record.id,
    displayId: displayIdFrom(record),
    kind: 'REPORT_CASE',
    status: record.status,
    version: record.version,
    reporterEntryCount: entryCount[0]?.total ?? 0,
    referenceCount: referenceCount[0]?.total ?? 0,
    caseClosedAt: serializeDate(record.caseClosedAt),
    updatedAt: record.updatedAt.toISOString(),
  };
};

const readReportCaseById = async (
  database: ReportDatabase,
  reportId: string,
  lock = false
): Promise<ReportCaseListRow | undefined> => {
  const query = database
    .select({
      reportCase: adminReportCase,
      conversationId: chatMessage.conversationId,
      questId: chatConversation.questId,
    })
    .from(adminReportCase)
    .innerJoin(chatMessage, eq(chatMessage.id, adminReportCase.messageId))
    .innerJoin(chatConversation, eq(chatConversation.id, chatMessage.conversationId))
    .where(eq(adminReportCase.id, reportId));

  const rows = lock ? await query.for('update') : await query.limit(1);
  return rows[0];
};

const summaryRows = async (
  database: ReportDatabase,
  rows: ReportCaseListRow[]
): Promise<ReportCaseSummary[]> => {
  const reportCaseIds = rows.map((row) => row.reportCase.id);
  const [reporters, references] = await Promise.all([
    reporterRowsFor(database, reportCaseIds),
    evidenceReferenceRowsFor(database, reportCaseIds),
  ]);
  return rows.map((row) => summaryFrom(row, reporters, references));
};

export type ListAdminReportCasesInput = {
  kind?: 'REPORT_CASE';
  status?: ReportCaseStatus;
  memberId?: string;
  questId?: string;
  limit?: number;
  cursor?: CursorPayload;
  sort?: 'newest' | 'oldest';
};

export const listAdminReportCases = async ({
  status,
  memberId,
  questId,
  limit = 20,
  cursor,
  sort = 'newest',
}: ListAdminReportCasesInput = {}) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new CursorInputError('INVALID_LIMIT', 'Report Case limit must be between 1 and 50.');
  }

  const where = and(
    status
      ? eq(adminReportCase.status, status)
      : inArray(adminReportCase.status, [reportCaseStatus.pending, reportCaseStatus.hidden]),
    memberId
      ? exists(
          db
            .select({ id: chatMembership.id })
            .from(chatMembership)
            .where(
              and(
                eq(chatMembership.id, chatMessage.senderMembershipId),
                eq(chatMembership.memberId, memberId)
              )
            )
        )
      : undefined,
    questId ? eq(chatConversation.questId, questId) : undefined
  );

  const page = await readKeysetPage({
    anchor: { time: adminReportCase.createdAt, id: adminReportCase.id },
    cursor,
    limit,
    sort,
    where,
    read: ({ where: pageWhere, orderBy, limit: probe }) =>
      db
        .select({
          reportCase: adminReportCase,
          conversationId: chatMessage.conversationId,
          questId: chatConversation.questId,
        })
        .from(adminReportCase)
        .innerJoin(chatMessage, eq(chatMessage.id, adminReportCase.messageId))
        .innerJoin(chatConversation, eq(chatConversation.id, chatMessage.conversationId))
        .where(pageWhere)
        .orderBy(...orderBy)
        .limit(probe),
    rowCursor: (row) => ({ startTime: row.reportCase.createdAt, id: row.reportCase.id }),
    invalidCursor: () => new CursorInputError('INVALID_CURSOR', 'Report Case cursor is invalid.'),
  });

  return {
    items: await summaryRows(db, page.rows),
    nextCursor: page.nextCursor,
  };
};

export const getAdminReportCase = async (reportId: string): Promise<ReportCaseSummary> => {
  const row = await readReportCaseById(db, reportId);
  if (!row) throw new AdminReportCaseError('REPORT_CASE_NOT_FOUND', 'Report Case does not exist.');
  const [summary] = await summaryRows(db, [row]);
  return summary!;
};

const assertTransition = (currentStatus: ReportCaseStatus, outcome: ReportCaseOutcome): void => {
  const allowed =
    currentStatus === reportCaseStatus.pending
      ? [reportCaseStatus.dismissed, reportCaseStatus.hidden]
      : currentStatus === reportCaseStatus.hidden
        ? [reportCaseStatus.dismissed, reportCaseStatus.hidden, reportCaseStatus.restored]
        : [];

  if (!allowed.includes(outcome)) {
    throw new AdminReportCaseError(
      'REPORT_CASE_OUTCOME_INVALID',
      'The Report Case is not in a state that accepts this outcome.'
    );
  }
};

const hideMessageInTransaction = async (
  database: ReportDatabase,
  messageId: string,
  conversationId: string,
  adminId: string,
  now: Date
) => {
  await database
    .update(chatMessage)
    .set({ hiddenAt: now, hiddenByAdminId: adminId })
    .where(and(eq(chatMessage.id, messageId), isNull(chatMessage.hiddenAt)));
  await database
    .update(chatAttachment)
    .set({ status: 'HIDDEN', hiddenAt: now, updatedAt: now })
    .where(
      and(
        inArray(
          chatAttachment.id,
          database
            .select({ attachmentId: chatMessageAttachment.attachmentId })
            .from(chatMessageAttachment)
            .where(eq(chatMessageAttachment.messageId, messageId))
        ),
        eq(chatAttachment.conversationId, conversationId),
        eq(chatAttachment.status, 'CONSUMED'),
        isNull(chatAttachment.deletedAt)
      )
    );
};

const restoreMessageInTransaction = async (
  database: ReportDatabase,
  messageId: string,
  conversationId: string,
  now: Date
) => {
  await database
    .update(chatMessage)
    .set({ hiddenAt: null, hiddenByAdminId: null })
    .where(eq(chatMessage.id, messageId));
  await database
    .update(chatAttachment)
    .set({ status: 'CONSUMED', hiddenAt: null, updatedAt: now })
    .where(
      and(
        inArray(
          chatAttachment.id,
          database
            .select({ attachmentId: chatMessageAttachment.attachmentId })
            .from(chatMessageAttachment)
            .where(eq(chatMessageAttachment.messageId, messageId))
        ),
        eq(chatAttachment.conversationId, conversationId),
        eq(chatAttachment.status, 'HIDDEN'),
        isNull(chatAttachment.deletedAt)
      )
    );
};

export type DecideAdminReportCaseInput = {
  adminId: string;
  reportId: string;
  expectedVersion: number;
  requestKey: string;
  reasonCode?: string;
  outcome: ReportCaseOutcome;
  now?: Date;
};

export type DecideAdminReportCaseResult = AdminActionResult<ReportCaseCommandSummary> & {
  outcome: ReportCaseOutcome;
};

export const decideAdminReportCase = async (
  input: DecideAdminReportCaseInput
): Promise<DecideAdminReportCaseResult> => {
  const now = input.now ?? new Date();
  const action =
    input.outcome === reportCaseStatus.dismissed
      ? 'REPORT_CASE_DISMISS'
      : input.outcome === reportCaseStatus.hidden
        ? 'REPORT_CASE_HIDE'
        : 'REPORT_CASE_RESTORE';

  const result = await adminActionService.executeCommand({
    adminId: input.adminId,
    action,
    resourceType: 'report_case',
    resourceId: input.reportId,
    requestKey: input.requestKey,
    reasonCode: input.reasonCode,
    request: { outcome: input.outcome },
    metadata: { outcome: input.outcome },
    expectedVersion: input.expectedVersion,
    prepare: async (database) => {
      const current = await readReportCaseById(database, input.reportId, true);
      if (!current) {
        throw new AdminReportCaseError('REPORT_CASE_NOT_FOUND', 'Report Case does not exist.');
      }
      assertTransition(current.reportCase.status, input.outcome);

      return {
        currentVersion: current.reportCase.version,
        apply: async () => {
          if (input.outcome === reportCaseStatus.hidden) {
            await hideMessageInTransaction(
              database,
              current.reportCase.messageId,
              current.conversationId,
              input.adminId,
              now
            );
          } else if (input.outcome === reportCaseStatus.restored) {
            await restoreMessageInTransaction(
              database,
              current.reportCase.messageId,
              current.conversationId,
              now
            );
          }

          await database.insert(adminModerationDecision).values({
            reportCaseId: current.reportCase.id,
            adminId: input.adminId,
            previousStatus: current.reportCase.status,
            newStatus: input.outcome,
            reasonCatalogVersion: reportAdminActionCatalog.version,
            reasonCode: input.reasonCode!,
            createdAt: now,
          });

          const [updated] = await database
            .update(adminReportCase)
            .set({
              status: input.outcome,
              caseClosedAt: input.outcome === reportCaseStatus.hidden ? null : now,
              version: sql`${adminReportCase.version} + 1`,
              updatedAt: now,
            })
            .where(eq(adminReportCase.id, current.reportCase.id))
            .returning();
          if (!updated) {
            throw new AdminReportCaseError(
              'REPORT_CASE_NOT_FOUND',
              'Report Case could not be updated.'
            );
          }

          return {
            resourceSummary: await commandSummaryInTransaction(database, updated),
            resourceVersion: updated.version,
            resourceTimestamp: null,
          };
        },
      };
    },
  });

  return { ...result, outcome: input.outcome };
};

type EvidenceMessageRow = {
  id: string;
  conversationId: string;
  sequence: number;
  kind: 'USER' | 'SYSTEM';
  contentText: string | null;
  systemType: string | null;
  systemPayload: Record<string, unknown> | null;
  createdAt: Date;
  senderId: string | null;
  senderEmail: string | null;
  senderFirstName: string | null;
  senderLastName: string | null;
};

const selectEvidenceMessageRows = async (
  database: ReportDatabase,
  where: ReturnType<typeof and>,
  orderBy: 'asc' | 'desc',
  limit: number
): Promise<EvidenceMessageRow[]> =>
  database
    .select({
      id: chatMessage.id,
      conversationId: chatMessage.conversationId,
      sequence: chatMessage.sequence,
      kind: chatMessage.kind,
      contentText: chatMessage.contentText,
      systemType: chatMessage.systemType,
      systemPayload: chatMessage.systemPayload,
      createdAt: chatMessage.createdAt,
      senderId: authUser.id,
      senderEmail: authUser.email,
      senderFirstName: authUser.firstName,
      senderLastName: authUser.lastName,
    })
    .from(chatMessage)
    .leftJoin(chatMembership, eq(chatMembership.id, chatMessage.senderMembershipId))
    .leftJoin(authUser, eq(authUser.id, chatMembership.memberId))
    .where(where)
    .orderBy(
      orderBy === 'asc' ? asc(chatMessage.sequence) : desc(chatMessage.sequence),
      orderBy === 'asc' ? asc(chatMessage.id) : desc(chatMessage.id)
    )
    .limit(limit);

const evidenceMessageFrom = (row: EvidenceMessageRow): AdminReportEvidence['messages'][number] => ({
  id: row.id,
  conversationId: row.conversationId,
  sequence: row.sequence,
  kind: row.kind,
  sender:
    row.senderId === null
      ? null
      : {
          id: row.senderId,
          email: row.senderEmail!,
          firstName: row.senderFirstName!,
          lastName: row.senderLastName!,
        },
  contentText: row.contentText,
  systemType: row.systemType,
  systemPayload: row.systemPayload,
  createdAt: row.createdAt.toISOString(),
  attachments: [],
});

const evidenceForInTransaction = async (
  database: ReportDatabase,
  evidenceRefId: string
): Promise<AdminReportEvidence> => {
  const [reference] = await database
    .select({
      caseId: adminReportCase.id,
      caseStatus: adminReportCase.status,
      reportMessageId: adminReportCase.messageId,
      messageId: adminEvidenceReference.messageId,
      attachmentId: adminEvidenceReference.attachmentId,
      conversationId: chatMessage.conversationId,
    })
    .from(adminEvidenceReference)
    .innerJoin(adminReportCase, eq(adminReportCase.id, adminEvidenceReference.reportCaseId))
    .innerJoin(chatMessage, eq(chatMessage.id, adminReportCase.messageId))
    .where(eq(adminEvidenceReference.id, evidenceRefId))
    .limit(1);
  if (!reference) {
    throw new AdminReportCaseError('REPORT_EVIDENCE_NOT_FOUND', 'Report evidence does not exist.');
  }
  if (
    reference.caseStatus !== reportCaseStatus.pending &&
    reference.caseStatus !== reportCaseStatus.hidden
  ) {
    throw new AdminReportCaseError('REPORT_EVIDENCE_NOT_FOUND', 'Report evidence does not exist.');
  }

  if (reference.messageId && reference.messageId !== reference.reportMessageId) {
    throw new AdminReportCaseError('REPORT_EVIDENCE_NOT_FOUND', 'Report evidence does not exist.');
  }

  if (reference.attachmentId) {
    const [attachmentReference] = await database
      .select({ messageId: chatMessageAttachment.messageId })
      .from(chatMessageAttachment)
      .innerJoin(chatAttachment, eq(chatAttachment.id, chatMessageAttachment.attachmentId))
      .where(
        and(
          eq(chatMessageAttachment.attachmentId, reference.attachmentId),
          eq(chatMessageAttachment.messageId, reference.reportMessageId),
          eq(chatAttachment.conversationId, reference.conversationId)
        )
      )
      .limit(1);
    if (!attachmentReference) {
      throw new AdminReportCaseError(
        'REPORT_EVIDENCE_NOT_FOUND',
        'Report evidence does not exist.'
      );
    }
  }

  const [target] = await selectEvidenceMessageRows(
    database,
    and(eq(chatMessage.id, reference.reportMessageId), isNull(chatMessage.deletedAt)),
    'asc',
    1
  );
  if (!target || target.conversationId !== reference.conversationId) {
    throw new AdminReportCaseError('REPORT_EVIDENCE_NOT_FOUND', 'Report evidence does not exist.');
  }

  const [before, after] = await Promise.all([
    selectEvidenceMessageRows(
      database,
      and(
        eq(chatMessage.conversationId, target.conversationId),
        lt(chatMessage.sequence, target.sequence),
        isNull(chatMessage.deletedAt)
      ),
      'desc',
      evidenceProbeLimit
    ),
    selectEvidenceMessageRows(
      database,
      and(
        eq(chatMessage.conversationId, target.conversationId),
        gt(chatMessage.sequence, target.sequence),
        isNull(chatMessage.deletedAt)
      ),
      'asc',
      evidenceProbeLimit
    ),
  ]);

  const targetAttachmentRows = await database
    .select({
      id: chatAttachment.id,
      status: chatAttachment.status,
      originalFilename: chatAttachment.originalFilename,
      mimeType: chatAttachment.mimeType,
      sizeBytes: chatAttachment.sizeBytes,
      bucket: file.bucket,
      objectKey: file.objectKey,
      attachmentObjectDeletedAt: chatAttachment.objectDeletedAt,
      fileObjectDeletedAt: file.objectDeletedAt,
      fileDeletedAt: file.deletedAt,
    })
    .from(chatMessageAttachment)
    .innerJoin(chatAttachment, eq(chatAttachment.id, chatMessageAttachment.attachmentId))
    .leftJoin(file, eq(file.id, chatAttachment.fileId))
    .where(
      and(
        eq(chatMessageAttachment.messageId, target.id),
        eq(chatAttachment.conversationId, target.conversationId),
        inArray(chatAttachment.status, ['CONSUMED', 'HIDDEN']),
        isNull(chatAttachment.deletedAt)
      )
    )
    .orderBy(asc(chatMessageAttachment.position));

  const targetWithAttachments = evidenceMessageFrom(target);
  targetWithAttachments.attachments = targetAttachmentRows.map((attachment) => {
    if (
      !attachment.bucket ||
      !attachment.objectKey ||
      attachment.attachmentObjectDeletedAt ||
      attachment.fileObjectDeletedAt ||
      attachment.fileDeletedAt
    ) {
      return {
        id: attachment.id,
        status: attachment.status,
        originalFilename: attachment.originalFilename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        url: null,
        urlExpiresAt: null,
      };
    }
    const link = workChatStorage.linkForWithExpiry({
      bucket: attachment.bucket,
      objectKey: attachment.objectKey,
    });
    return {
      id: attachment.id,
      status: attachment.status,
      originalFilename: attachment.originalFilename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      url: link.url,
      urlExpiresAt: link.expiresAt.toISOString(),
    };
  });

  return {
    caseId: reference.caseId,
    evidenceRefId,
    reportedMessageId: target.id,
    truncated:
      before.length > maxEvidenceContextMessages || after.length > maxEvidenceContextMessages,
    messages: [
      ...before.slice(0, maxEvidenceContextMessages).reverse().map(evidenceMessageFrom),
      targetWithAttachments,
      ...after.slice(0, maxEvidenceContextMessages).map(evidenceMessageFrom),
    ],
  };
};

const reportCaseIdForEvidence = async (evidenceRefId: string): Promise<string> => {
  const [reference] = await db
    .select({ caseId: adminEvidenceReference.reportCaseId })
    .from(adminEvidenceReference)
    .where(eq(adminEvidenceReference.id, evidenceRefId))
    .limit(1);
  if (!reference) {
    throw new AdminReportCaseError('REPORT_EVIDENCE_NOT_FOUND', 'Report evidence does not exist.');
  }
  return reference.caseId;
};

export const getAdminReportEvidence = async (
  adminId: string,
  evidenceRefId: string,
  requestKey: string
): Promise<AdminReportEvidenceData> => {
  const reportCaseId = await reportCaseIdForEvidence(evidenceRefId);
  let evidence: AdminReportEvidence | undefined;
  const result = await adminActionService.recordEvidenceAccess({
    adminId,
    action: 'REPORT_CASE_EVIDENCE_ACCESS',
    resourceType: 'report_case',
    resourceId: reportCaseId,
    requestKey,
    request: { view: 'case-scoped-evidence', evidenceRef: evidenceRefId },
    metadata: { scope: 'report-case' },
    read: async (database) => {
      const loaded = await evidenceForInTransaction(database, evidenceRefId);
      evidence = loaded;
      return {
        resourceSummary: {
          caseId: loaded.caseId,
          referenceId: loaded.evidenceRefId,
          itemCount: loaded.messages.length,
        },
        resourceVersion: null,
        resourceTimestamp: null,
      };
    },
  });

  const loaded =
    evidence ??
    (await db.transaction((database) => evidenceForInTransaction(database, evidenceRefId)));
  return { ...loaded, adminActionId: result.adminActionId };
};
