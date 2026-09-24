import { db } from '@/database/client';
import {
  adminConductReport,
  adminConductReportEvidenceHandle,
  adminEvidenceReference,
  adminModerationDecision,
  adminReportCase,
  adminReporterEntry,
  conductReportStatus,
  reportCaseStatus,
  type ConductReportStatus,
  type ReportCaseStatus,
} from '@/database/schema/admin.schema';
import { authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';
import {
  proofSubmission,
  quest,
  questAssignment,
  questCandidateTeamV2,
  questCandidateTeamV2Member,
  questTeam,
  questTeamMember,
  questV2ProofSubmission,
} from '@/database/schema/quest.schema';
import {
  chatAttachment,
  chatConversation,
  chatMembership,
  chatMessage,
  chatMessageAttachment,
} from '@/database/schema/work-chat.schema';
import { CursorInputError, encodeCursor, type CursorPayload } from '@/shared/cursor';
import {
  readKeysetPage,
  type KeysetAnchor,
  type KeysetCursorAnchor,
  type KeysetSort,
} from '@/shared/keyset-page';
import { workChatStorage } from '@/modules/work-chat';

import { createHash, randomBytes } from 'node:crypto';

import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type {
  AdminConductReportCommandSummary,
  AdminConductReportDetail,
  AdminConductReportSummary,
  AdminReportCommandSummary,
  AdminReportDetailData,
  AdminReportEvidenceData,
  AdminReportListData,
  AdminReportListQuery,
} from './admin-report.schema';
import {
  createAdminActionService,
  type AdminActionResult,
  type AdminActionTransaction,
} from './admin-action.service';
import { formatConductReportDisplayId, formatReportCaseDisplayId } from './admin-display-id';
import {
  reportAdminActionCatalog,
  type ConductReportDismissReasonCode,
} from './admin-report.policy';

export type ReportCaseOutcome =
  'REPORT_CASE_DISMISSED' | 'REPORT_CASE_HIDDEN' | 'REPORT_CASE_RESTORED';

const adminActionService = createAdminActionService(reportAdminActionCatalog);
const maxEvidenceContextMessages = 3;
const evidenceProbeLimit = maxEvidenceContextMessages + 1;

export class AdminReportError extends Error {
  readonly code:
    | 'REPORT_CASE_NOT_FOUND'
    | 'REPORT_CASE_OUTCOME_INVALID'
    | 'CONDUCT_REPORT_NOT_FOUND'
    | 'CONDUCT_REPORT_OUTCOME_INVALID'
    | 'REPORT_EVIDENCE_NOT_FOUND';

  constructor(code: AdminReportError['code'], message: string) {
    super(message);
    this.name = 'AdminReportError';
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

type AdminReportKind = 'REPORT_CASE' | 'CONDUCT_REPORT';
type ConductReportMember = Pick<
  typeof authUser.$inferSelect,
  'id' | 'email' | 'firstName' | 'lastName'
>;
type ConductReportQuest = Pick<
  typeof quest.$inferSelect,
  | 'id'
  | 'publicSequence'
  | 'apiVersion'
  | 'title'
  | 'mode'
  | 'participation'
  | 'v2Mode'
  | 'v2Participation'
  | 'questStatus'
  | 'failedAt'
  | 'cancelledAt'
  | 'headcount'
  | 'proofRequired'
  | 'startTime'
  | 'dueAt'
  | 'createdAt'
  | 'updatedAt'
>;
type ConductReportListRow = {
  report: typeof adminConductReport.$inferSelect;
  filer: ConductReportMember;
  reportedMember: ConductReportMember;
  quest: ConductReportQuest;
  hirer: ConductReportMember;
  sortCreatedAt: string;
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

type ReportCaseSummary = Extract<AdminReportListData['items'][number], { kind: 'REPORT_CASE' }>;
type ConductReportSummary = AdminConductReportSummary;
type ConductReportDetail = AdminConductReportDetail;
type AdminReportStatus = NonNullable<AdminReportListQuery['status']>;
type ReportCaseCommandSummary = Extract<AdminReportCommandSummary, { kind: 'REPORT_CASE' }>;
type ConductReportCommandSummary = AdminConductReportCommandSummary;
type AdminReportCaseEvidence = Extract<AdminReportEvidenceData, { caseId: string }>;
type AdminConductReportEvidence = Extract<AdminReportEvidenceData, { conductReportId: string }>;
type AdminReportCaseEvidenceWithoutAction = Omit<AdminReportCaseEvidence, 'adminActionId'>;
type AdminConductReportEvidenceWithoutAction = Omit<AdminConductReportEvidence, 'adminActionId'>;
type AdminReportEvidenceMessage = AdminReportCaseEvidence['messages'][number];
type AdminReportEvidencePageInput = { limit: number; cursor?: CursorPayload };

const conductReportFilerUser = alias(authUser, 'conduct_report_filer');
const conductReportReportedUser = alias(authUser, 'conduct_report_reported_member');
const conductReportHirerUser = alias(authUser, 'conduct_report_hirer');
const conductReportAssignmentWorker = alias(authUser, 'conduct_report_assignment_worker');
const conductReportProofSubmitter = alias(authUser, 'conduct_report_proof_submitter');
const conductReportEvidenceCandidate = alias(authUser, 'conduct_report_evidence_candidate');
const conductReportEvidenceWorkConversation = alias(
  chatConversation,
  'conduct_report_evidence_work_conversation'
);

const conductReportEvidenceHandlePrefix = 'CRH_';
const conductReportEvidenceCursorScope = 'CONDUCT_REPORT_EVIDENCE';

const newConductReportEvidenceHandle = (): string =>
  `${conductReportEvidenceHandlePrefix}${randomBytes(32).toString('base64url')}`;

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

const selectConductReportRows = (database: ReportDatabase) =>
  database
    .select({
      report: adminConductReport,
      filer: {
        id: conductReportFilerUser.id,
        email: conductReportFilerUser.email,
        firstName: conductReportFilerUser.firstName,
        lastName: conductReportFilerUser.lastName,
      },
      reportedMember: {
        id: conductReportReportedUser.id,
        email: conductReportReportedUser.email,
        firstName: conductReportReportedUser.firstName,
        lastName: conductReportReportedUser.lastName,
      },
      quest: {
        id: quest.id,
        publicSequence: quest.publicSequence,
        apiVersion: quest.apiVersion,
        title: quest.title,
        mode: quest.mode,
        participation: quest.participation,
        v2Mode: quest.v2Mode,
        v2Participation: quest.v2Participation,
        questStatus: quest.questStatus,
        failedAt: quest.failedAt,
        cancelledAt: quest.cancelledAt,
        headcount: quest.headcount,
        proofRequired: quest.proofRequired,
        startTime: quest.startTime,
        dueAt: quest.dueAt,
        createdAt: quest.createdAt,
        updatedAt: quest.updatedAt,
      },
      hirer: {
        id: conductReportHirerUser.id,
        email: conductReportHirerUser.email,
        firstName: conductReportHirerUser.firstName,
        lastName: conductReportHirerUser.lastName,
      },
      sortCreatedAt: sql<string>`to_char(${adminConductReport.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(adminConductReport)
    .innerJoin(quest, eq(quest.id, adminConductReport.questId))
    .innerJoin(
      conductReportFilerUser,
      eq(conductReportFilerUser.id, adminConductReport.filerUserId)
    )
    .innerJoin(
      conductReportReportedUser,
      eq(conductReportReportedUser.id, adminConductReport.reportedMemberId)
    )
    .innerJoin(conductReportHirerUser, eq(conductReportHirerUser.id, quest.hirerId));

const canonicalQuestMode = (row: ConductReportQuest): ConductReportSummary['quest']['mode'] =>
  row.apiVersion === 'v2' && row.v2Mode
    ? row.v2Mode
    : row.mode === 'NO_CANDIDATE'
      ? 'FIRST_COME_FIRST_SERVED'
      : 'CANDIDATE';

const canonicalQuestParticipation = (
  row: ConductReportQuest
): ConductReportSummary['quest']['participation'] =>
  row.apiVersion === 'v2' && row.v2Participation
    ? row.v2Participation
    : row.participation === 'SOLO'
      ? 'SINGLE'
      : 'GROUP';

const conductReportSummaryFrom = (row: ConductReportListRow): ConductReportSummary => ({
  kind: 'CONDUCT_REPORT',
  id: row.report.id,
  displayId: formatConductReportDisplayId(row.report.publicSequence),
  filer: row.filer,
  reportedMember: row.reportedMember,
  quest: {
    id: row.quest.id,
    displayId: `QST-${row.quest.publicSequence.toString().padStart(6, '0')}`,
    title: row.quest.title,
    questStatus: row.quest.questStatus,
    mode: canonicalQuestMode(row.quest),
    participation: canonicalQuestParticipation(row.quest),
    headcount: row.quest.headcount,
    proofRequired: row.quest.proofRequired,
    startTime: row.quest.startTime.toISOString(),
    dueAt: serializeDate(row.quest.dueAt),
    createdAt: row.quest.createdAt.toISOString(),
    updatedAt: row.quest.updatedAt.toISOString(),
    hirer: row.hirer,
  },
  reason: row.report.reason,
  detail: row.report.detail,
  status: row.report.status,
  version: row.report.version,
  createdAt: row.report.createdAt.toISOString(),
  updatedAt: row.report.updatedAt.toISOString(),
  resolvedAt: serializeDate(row.report.resolvedAt),
});

const readAdminReportCursorAnchor = async (cursor: CursorPayload) => {
  const readCase = async () => {
    const [row] = await db
      .select({ startTime: adminReportCase.createdAt })
      .from(adminReportCase)
      .where(eq(adminReportCase.id, cursor.id))
      .limit(1);
    return row ? { ...row, id: cursor.id, scope: 'REPORT_CASE' as const } : undefined;
  };
  const readConductReport = async () => {
    const [row] = await db
      .select({ startTime: adminConductReport.createdAt })
      .from(adminConductReport)
      .where(eq(adminConductReport.id, cursor.id))
      .limit(1);
    return row ? { ...row, id: cursor.id, scope: 'CONDUCT_REPORT' as const } : undefined;
  };

  if (cursor.scope === 'REPORT_CASE') return readCase();
  if (cursor.scope === 'CONDUCT_REPORT') return readConductReport();
  if (cursor.scope !== undefined) return undefined;

  const [caseAnchor, conductAnchor] = await Promise.all([readCase(), readConductReport()]);
  if (caseAnchor && conductAnchor) return undefined;
  return caseAnchor ?? conductAnchor;
};

const cursorAnchorFor = (kind: AdminReportKind, target: KeysetAnchor): KeysetCursorAnchor => ({
  read: readAdminReportCursorAnchor,
  boundary: (anchor, sort) => {
    const source =
      anchor.scope === 'REPORT_CASE'
        ? {
            table: adminReportCase,
            time: adminReportCase.createdAt,
            id: adminReportCase.id,
          }
        : {
            table: adminConductReport,
            time: adminConductReport.createdAt,
            id: adminConductReport.id,
          };
    const anchorRow = sql`(
      select ${source.time}, ${source.id}, ${anchor.scope}::text
      from ${source.table}
      where ${source.id} = ${anchor.id}
    )`;
    return sort === 'oldest'
      ? sql`(${target.time}, ${target.id}, ${kind}::text) > ${anchorRow}`
      : sql`(${target.time}, ${target.id}, ${kind}::text) < ${anchorRow}`;
  },
  orderBy: (sort: KeysetSort) =>
    sort === 'oldest' ? [asc(target.time), asc(target.id)] : [desc(target.time), desc(target.id)],
});

const isReportCaseStatus = (status: AdminReportStatus): status is ReportCaseStatus =>
  Object.values(reportCaseStatus).includes(status as ReportCaseStatus);

const isConductReportStatus = (status: AdminReportStatus): status is ConductReportStatus =>
  Object.values(conductReportStatus).includes(status as ConductReportStatus);

export type ListAdminReportsInput = {
  kind?: AdminReportKind;
  status?: AdminReportStatus;
  memberId?: string;
  questId?: string;
  limit?: number;
  cursor?: CursorPayload;
  sort?: KeysetSort;
};

export const listAdminReports = async ({
  kind,
  status,
  memberId,
  questId,
  limit = 20,
  cursor,
  sort = 'newest',
}: ListAdminReportsInput = {}) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new CursorInputError('INVALID_LIMIT', 'Report list limit must be between 1 and 50.');
  }

  const includeReportCases =
    kind !== 'CONDUCT_REPORT' && (status === undefined || isReportCaseStatus(status));
  const includeConductReports =
    kind !== 'REPORT_CASE' && (status === undefined || isConductReportStatus(status));
  const reportCaseStatusValue = status && isReportCaseStatus(status) ? status : undefined;
  const conductReportStatusValue = status && isConductReportStatus(status) ? status : undefined;

  const reportCaseWhere = and(
    reportCaseStatusValue
      ? eq(adminReportCase.status, reportCaseStatusValue)
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
  const conductReportWhere = and(
    conductReportStatusValue
      ? eq(adminConductReport.status, conductReportStatusValue)
      : eq(adminConductReport.status, conductReportStatus.pending),
    memberId ? eq(adminConductReport.reportedMemberId, memberId) : undefined,
    questId ? eq(adminConductReport.questId, questId) : undefined
  );

  const [reportCasePage, conductReportPage] = await Promise.all([
    includeReportCases
      ? readKeysetPage({
          cursorAnchor: cursorAnchorFor('REPORT_CASE', {
            time: adminReportCase.createdAt,
            id: adminReportCase.id,
          }),
          cursor,
          limit,
          sort,
          where: reportCaseWhere,
          read: ({ where: pageWhere, orderBy, limit: probe }) =>
            db
              .select({
                reportCase: adminReportCase,
                conversationId: chatMessage.conversationId,
                questId: chatConversation.questId,
                sortCreatedAt: sql<string>`to_char(${adminReportCase.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
              })
              .from(adminReportCase)
              .innerJoin(chatMessage, eq(chatMessage.id, adminReportCase.messageId))
              .innerJoin(chatConversation, eq(chatConversation.id, chatMessage.conversationId))
              .where(pageWhere)
              .orderBy(...orderBy)
              .limit(probe),
          rowCursor: (row) => ({
            startTime: row.reportCase.createdAt,
            id: row.reportCase.id,
            scope: 'REPORT_CASE',
          }),
          invalidCursor: () =>
            new CursorInputError('INVALID_CURSOR', 'Report Case cursor is invalid.'),
        })
      : Promise.resolve({
          rows: [] as Array<ReportCaseListRow & { sortCreatedAt: string }>,
          hasNext: false,
        }),
    includeConductReports
      ? readKeysetPage({
          cursorAnchor: cursorAnchorFor('CONDUCT_REPORT', {
            time: adminConductReport.createdAt,
            id: adminConductReport.id,
          }),
          cursor,
          limit,
          sort,
          where: conductReportWhere,
          read: ({ where: pageWhere, orderBy, limit: probe }) =>
            selectConductReportRows(db)
              .where(pageWhere)
              .orderBy(...orderBy)
              .limit(probe),
          rowCursor: (row) => ({
            startTime: row.report.createdAt,
            id: row.report.id,
            scope: 'CONDUCT_REPORT',
          }),
          invalidCursor: () =>
            new CursorInputError('INVALID_CURSOR', 'Conduct Report cursor is invalid.'),
        })
      : Promise.resolve({ rows: [] as ConductReportListRow[], hasNext: false }),
  ]);

  const [reportCaseSummaries, conductReportSummaries] = await Promise.all([
    summaryRows(db, reportCasePage.rows),
    Promise.resolve(conductReportPage.rows.map(conductReportSummaryFrom)),
  ]);
  const compareText = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0;
  const sortFactor = sort === 'newest' ? -1 : 1;
  const sorted = [
    ...reportCaseSummaries.map((item, index) => ({
      item,
      sortCreatedAt: reportCasePage.rows[index]!.sortCreatedAt,
    })),
    ...conductReportSummaries.map((item, index) => ({
      item,
      sortCreatedAt: conductReportPage.rows[index]!.sortCreatedAt,
    })),
  ].sort(
    (left, right) =>
      sortFactor *
      (compareText(left.sortCreatedAt, right.sortCreatedAt) ||
        compareText(left.item.id, right.item.id) ||
        compareText(left.item.kind, right.item.kind))
  );
  const items = sorted.slice(0, limit).map(({ item }) => item);
  const hasNext = reportCasePage.hasNext || conductReportPage.hasNext || sorted.length > limit;
  const last = sorted[Math.min(limit, sorted.length) - 1];

  return {
    items,
    nextCursor:
      hasNext && last
        ? {
            startTime: last.item.createdAt,
            id: last.item.id,
            scope: last.item.kind,
          }
        : null,
  };
};

type ConductReportProofRow = {
  id: string;
  workerId: string | null;
  teamId: string | null;
  submittedBy: ConductReportMember;
  description: string | null;
  workerMessage: string | null;
  content: string | null;
  submissionStatus: 'PROOF_PENDING' | 'PROOF_APPROVED' | 'PROOF_NOT_APPROVED' | null;
  reviewNote: string | null;
  sentAt: Date | null;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date | null;
};

const selectedCandidateTeamId = async (
  database: ReportDatabase,
  questRow: ConductReportQuest,
  workerId: string
): Promise<string | undefined> => {
  if (
    questRow.apiVersion === 'v2' &&
    questRow.v2Mode === 'CANDIDATE' &&
    questRow.v2Participation === 'GROUP'
  ) {
    const [team] = await database
      .select({ id: questCandidateTeamV2.id })
      .from(questCandidateTeamV2)
      .innerJoin(
        questCandidateTeamV2Member,
        eq(questCandidateTeamV2Member.teamId, questCandidateTeamV2.id)
      )
      .where(
        and(
          eq(questCandidateTeamV2.questId, questRow.id),
          eq(questCandidateTeamV2Member.memberId, workerId),
          eq(questCandidateTeamV2.state, 'TEAM_SELECTED')
        )
      )
      .limit(1);
    return team?.id;
  }

  if (
    questRow.apiVersion !== 'v2' &&
    questRow.mode === 'CANDIDATE' &&
    questRow.participation === 'GROUP'
  ) {
    const [team] = await database
      .select({ id: questTeam.id })
      .from(questTeam)
      .innerJoin(questTeamMember, eq(questTeamMember.teamId, questTeam.id))
      .where(
        and(
          eq(questTeam.questId, questRow.id),
          eq(questTeamMember.userId, workerId),
          eq(questTeam.teamStatus, 'TEAM_SELECTED')
        )
      )
      .limit(1);
    return team?.id;
  }

  return undefined;
};

const conductReportProofRowFor = async (
  database: ReportDatabase,
  questRow: ConductReportQuest,
  workerId: string
): Promise<ConductReportProofRow | undefined> => {
  const teamId = await selectedCandidateTeamId(database, questRow, workerId);
  if (
    (questRow.apiVersion === 'v2' &&
      questRow.v2Mode === 'CANDIDATE' &&
      questRow.v2Participation === 'GROUP' &&
      !teamId) ||
    (questRow.apiVersion !== 'v2' &&
      questRow.mode === 'CANDIDATE' &&
      questRow.participation === 'GROUP' &&
      !teamId)
  ) {
    return undefined;
  }

  if (questRow.apiVersion === 'v2') {
    const [row] = await database
      .select({
        id: questV2ProofSubmission.id,
        workerId: questV2ProofSubmission.workerId,
        teamId: questV2ProofSubmission.teamId,
        submittedBy: {
          id: conductReportProofSubmitter.id,
          email: conductReportProofSubmitter.email,
          firstName: conductReportProofSubmitter.firstName,
          lastName: conductReportProofSubmitter.lastName,
        },
        description: questV2ProofSubmission.description,
        workerMessage: questV2ProofSubmission.workerMessage,
        content: sql<string | null>`null`,
        submissionStatus: questV2ProofSubmission.submissionStatus,
        reviewNote: sql<string | null>`null`,
        sentAt: questV2ProofSubmission.sentAt,
        submittedAt: sql<Date | null>`null`,
        reviewedAt: sql<Date | null>`null`,
        createdAt: questV2ProofSubmission.createdAt,
        updatedAt: questV2ProofSubmission.updatedAt,
      })
      .from(questV2ProofSubmission)
      .innerJoin(
        conductReportProofSubmitter,
        eq(conductReportProofSubmitter.id, questV2ProofSubmission.submittedByUserId)
      )
      .where(
        and(
          eq(questV2ProofSubmission.questId, questRow.id),
          isNotNull(questV2ProofSubmission.sentAt),
          teamId
            ? eq(questV2ProofSubmission.teamId, teamId)
            : eq(questV2ProofSubmission.workerId, workerId)
        )
      )
      .orderBy(desc(questV2ProofSubmission.createdAt), desc(questV2ProofSubmission.id))
      .limit(1);
    return row;
  }

  const [row] = await database
    .select({
      id: proofSubmission.id,
      workerId: proofSubmission.workerId,
      teamId: proofSubmission.teamId,
      submittedBy: {
        id: conductReportProofSubmitter.id,
        email: conductReportProofSubmitter.email,
        firstName: conductReportProofSubmitter.firstName,
        lastName: conductReportProofSubmitter.lastName,
      },
      description: sql<string | null>`null`,
      workerMessage: sql<string | null>`null`,
      content: proofSubmission.content,
      submissionStatus: proofSubmission.submissionStatus,
      reviewNote: proofSubmission.reviewNote,
      sentAt: sql<Date | null>`null`,
      submittedAt: proofSubmission.submittedAt,
      reviewedAt: proofSubmission.reviewedAt,
      createdAt: proofSubmission.submittedAt,
      updatedAt: sql<Date | null>`null`,
    })
    .from(proofSubmission)
    .innerJoin(
      conductReportProofSubmitter,
      eq(conductReportProofSubmitter.id, proofSubmission.submittedByUserId)
    )
    .where(
      and(
        eq(proofSubmission.questId, questRow.id),
        teamId ? eq(proofSubmission.teamId, teamId) : eq(proofSubmission.workerId, workerId)
      )
    )
    .orderBy(desc(proofSubmission.submittedAt), desc(proofSubmission.id))
    .limit(1);
  return row
    ? {
        ...row,
        submissionStatus: row.submissionStatus as ConductReportProofRow['submissionStatus'],
      }
    : undefined;
};

type PermittedConductReportConversation = {
  id: string;
  conversationType: 'CONVERSATION_WORK' | 'CONVERSATION_CANDIDATE_INQUIRY';
  candidate: ConductReportMember | null;
  latestTerminalAt: Date | null;
};

type ConductReportEvidenceHandleSummary = ConductReportDetail['evidenceHandles'][number];

const oneCalendarYearAfter = (value: Date): Date => {
  const year = value.getUTCFullYear() + 1;
  const month = value.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const result = new Date(value);
  result.setUTCFullYear(year, month, Math.min(value.getUTCDate(), lastDay));
  return result;
};

const conductReportEvidenceExpiresAt = (
  questRow: Pick<ConductReportQuest, 'questStatus' | 'failedAt' | 'cancelledAt' | 'updatedAt'>,
  latestTerminalAt: Date | null
): Date | null => {
  const terminalAt =
    latestTerminalAt ??
    (questRow.questStatus === 'QUEST_FAILED'
      ? questRow.failedAt
      : questRow.questStatus === 'QUEST_CANCELLED'
        ? questRow.cancelledAt
        : questRow.questStatus === 'QUEST_COMPLETED'
          ? questRow.updatedAt
          : null);
  return terminalAt ? oneCalendarYearAfter(terminalAt) : null;
};

const permittedConductReportConversations = async (
  database: ReportDatabase,
  report: typeof adminConductReport.$inferSelect
): Promise<PermittedConductReportConversation[]> => {
  const [workConversation] = await database
    .select({
      id: chatConversation.id,
      latestTerminalAt: chatConversation.latestTerminalAt,
    })
    .from(chatConversation)
    .where(
      and(
        eq(chatConversation.questId, report.questId),
        eq(chatConversation.type, 'CONVERSATION_WORK'),
        isNull(chatConversation.deletedAt)
      )
    )
    .limit(1);

  const candidateInquiries = await database
    .select({
      id: chatConversation.id,
      candidate: {
        id: conductReportEvidenceCandidate.id,
        email: conductReportEvidenceCandidate.email,
        firstName: conductReportEvidenceCandidate.firstName,
        lastName: conductReportEvidenceCandidate.lastName,
      },
    })
    .from(chatConversation)
    .innerJoin(
      conductReportEvidenceCandidate,
      eq(conductReportEvidenceCandidate.id, chatConversation.candidateWorkerId)
    )
    .where(
      and(
        eq(chatConversation.questId, report.questId),
        eq(chatConversation.type, 'CONVERSATION_CANDIDATE_INQUIRY'),
        isNull(chatConversation.deletedAt),
        exists(
          database
            .select({ id: chatMembership.id })
            .from(chatMembership)
            .where(
              and(
                eq(chatMembership.conversationId, chatConversation.id),
                inArray(chatMembership.memberId, [report.filerUserId, report.reportedMemberId])
              )
            )
        )
      )
    )
    .orderBy(asc(chatConversation.createdAt), asc(chatConversation.id));

  return [
    ...(workConversation
      ? [
          {
            id: workConversation.id,
            conversationType: 'CONVERSATION_WORK' as const,
            candidate: null,
            latestTerminalAt: workConversation.latestTerminalAt,
          },
        ]
      : []),
    ...candidateInquiries.map((conversation) => ({
      id: conversation.id,
      conversationType: 'CONVERSATION_CANDIDATE_INQUIRY' as const,
      candidate: conversation.candidate,
      latestTerminalAt: workConversation?.latestTerminalAt ?? null,
    })),
  ];
};

const conductReportEvidenceHandlesFor = async (
  database: ReportDatabase,
  row: ConductReportListRow
): Promise<ConductReportEvidenceHandleSummary[]> => {
  const conversations = await permittedConductReportConversations(database, row.report);
  const now = new Date();
  const eligibleConversations = conversations.filter((conversation) => {
    const expiresAt = conductReportEvidenceExpiresAt(row.quest, conversation.latestTerminalAt);
    return expiresAt === null || expiresAt > now;
  });
  if (eligibleConversations.length === 0) return [];

  await database
    .insert(adminConductReportEvidenceHandle)
    .values(
      eligibleConversations.map((conversation) => ({
        id: newConductReportEvidenceHandle(),
        reportId: row.report.id,
        conversationId: conversation.id,
        createdAt: now,
      }))
    )
    .onConflictDoNothing({
      target: [
        adminConductReportEvidenceHandle.reportId,
        adminConductReportEvidenceHandle.conversationId,
      ],
    });

  const storedHandles = await database
    .select({
      handle: adminConductReportEvidenceHandle.id,
      conversationId: adminConductReportEvidenceHandle.conversationId,
    })
    .from(adminConductReportEvidenceHandle)
    .where(
      and(
        eq(adminConductReportEvidenceHandle.reportId, row.report.id),
        inArray(
          adminConductReportEvidenceHandle.conversationId,
          eligibleConversations.map((conversation) => conversation.id)
        )
      )
    );
  const handleByConversation = new Map(
    storedHandles.map((stored) => [stored.conversationId, stored.handle])
  );

  return eligibleConversations.flatMap((conversation) => {
    const handle = handleByConversation.get(conversation.id);
    if (!handle) return [];
    const expiresAt = conductReportEvidenceExpiresAt(row.quest, conversation.latestTerminalAt);
    return [
      {
        handle,
        conversationType: conversation.conversationType,
        candidate: conversation.candidate,
        expiresAt: expiresAt?.toISOString() ?? null,
      },
    ];
  });
};

export const getAdminReport = async (reportId: string): Promise<AdminReportDetailData> => {
  const reportCaseRow = await readReportCaseById(db, reportId);
  if (reportCaseRow) {
    const [summary] = await summaryRows(db, [reportCaseRow]);
    return summary!;
  }

  const [conductReportRow] = await selectConductReportRows(db)
    .where(eq(adminConductReport.id, reportId))
    .limit(1);
  if (!conductReportRow) {
    throw new AdminReportError('REPORT_CASE_NOT_FOUND', 'Report resource does not exist.');
  }

  const [assignmentRow] = await db
    .select({
      assignment: questAssignment,
      worker: {
        id: conductReportAssignmentWorker.id,
        email: conductReportAssignmentWorker.email,
        firstName: conductReportAssignmentWorker.firstName,
        lastName: conductReportAssignmentWorker.lastName,
      },
    })
    .from(questAssignment)
    .innerJoin(
      conductReportAssignmentWorker,
      eq(conductReportAssignmentWorker.id, questAssignment.workerId)
    )
    .where(
      and(
        eq(questAssignment.id, conductReportRow.report.assignmentId),
        eq(questAssignment.questId, conductReportRow.report.questId)
      )
    )
    .limit(1);
  if (!assignmentRow) {
    throw new AdminReportError('REPORT_CASE_NOT_FOUND', 'Report resource does not exist.');
  }

  const proofRow = await conductReportProofRowFor(
    db,
    conductReportRow.quest,
    assignmentRow.assignment.workerId
  );
  const summary = conductReportSummaryFrom(conductReportRow);
  const detail: ConductReportDetail = {
    ...summary,
    assignment: {
      id: assignmentRow.assignment.id,
      worker: assignmentRow.worker,
      assignmentStatus: assignmentRow.assignment
        .assignmentStatus as ConductReportDetail['assignment']['assignmentStatus'],
      startedAt: serializeDate(assignmentRow.assignment.startedAt),
      createdAt: assignmentRow.assignment.createdAt.toISOString(),
    },
    proofSubmission: proofRow
      ? {
          id: proofRow.id,
          workerId: proofRow.workerId,
          teamId: proofRow.teamId,
          submittedBy: proofRow.submittedBy,
          description: proofRow.description,
          workerMessage: proofRow.workerMessage,
          content: proofRow.content,
          submissionStatus: proofRow.submissionStatus,
          reviewNote: proofRow.reviewNote,
          sentAt: serializeDate(proofRow.sentAt),
          submittedAt: serializeDate(proofRow.submittedAt),
          reviewedAt: serializeDate(proofRow.reviewedAt),
          createdAt: proofRow.createdAt.toISOString(),
          updatedAt: serializeDate(proofRow.updatedAt),
        }
      : null,
    evidenceHandles: await db.transaction((transaction) =>
      conductReportEvidenceHandlesFor(transaction, conductReportRow)
    ),
  };
  return detail;
};

const assertTransition = (currentStatus: ReportCaseStatus, outcome: ReportCaseOutcome): void => {
  const allowed =
    currentStatus === reportCaseStatus.pending
      ? [reportCaseStatus.dismissed, reportCaseStatus.hidden]
      : currentStatus === reportCaseStatus.hidden
        ? [reportCaseStatus.dismissed, reportCaseStatus.hidden, reportCaseStatus.restored]
        : [];

  if (!allowed.includes(outcome)) {
    throw new AdminReportError(
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

type AdminReportCommandInput = {
  adminId: string;
  reportId: string;
  expectedVersion: number;
  requestKey: string;
};

export type DecideAdminReportCaseInput = AdminReportCommandInput & {
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
        throw new AdminReportError('REPORT_CASE_NOT_FOUND', 'Report Case does not exist.');
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
            throw new AdminReportError(
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

type DismissAdminConductReportInput = AdminReportCommandInput & {
  decisionReasonCode: ConductReportDismissReasonCode;
};

const dismissAdminConductReport = async (
  input: DismissAdminConductReportInput
): Promise<AdminActionResult<ConductReportCommandSummary>> => {
  const now = new Date();

  return adminActionService.executeCommand<ConductReportCommandSummary>({
    adminId: input.adminId,
    action: 'CONDUCT_REPORT_DISMISS',
    resourceType: 'conduct_report',
    resourceId: input.reportId,
    requestKey: input.requestKey,
    reasonCode: input.decisionReasonCode,
    request: { outcome: conductReportStatus.dismissed },
    metadata: { outcome: conductReportStatus.dismissed },
    expectedVersion: input.expectedVersion,
    prepare: async (database) => {
      const [current] = await database
        .select({ status: adminConductReport.status, version: adminConductReport.version })
        .from(adminConductReport)
        .where(eq(adminConductReport.id, input.reportId))
        .limit(1)
        .for('update');
      if (!current) {
        throw new AdminReportError('CONDUCT_REPORT_NOT_FOUND', 'Conduct Report does not exist.');
      }
      return {
        currentVersion: current.version,
        apply: async () => {
          if (current.status !== conductReportStatus.pending) {
            throw new AdminReportError(
              'CONDUCT_REPORT_OUTCOME_INVALID',
              'Only a pending Conduct Report can be dismissed.'
            );
          }

          const [updated] = await database
            .update(adminConductReport)
            .set({
              status: conductReportStatus.dismissed,
              decisionReason: input.decisionReasonCode,
              resolvedByAdminId: input.adminId,
              resolvedAt: now,
              version: sql`${adminConductReport.version} + 1`,
              updatedAt: now,
            })
            .where(
              and(
                eq(adminConductReport.id, input.reportId),
                eq(adminConductReport.version, current.version)
              )
            )
            .returning({
              id: adminConductReport.id,
              publicSequence: adminConductReport.publicSequence,
              status: adminConductReport.status,
              version: adminConductReport.version,
              updatedAt: adminConductReport.updatedAt,
              resolvedAt: adminConductReport.resolvedAt,
            });
          if (!updated) {
            throw new AdminReportError(
              'CONDUCT_REPORT_NOT_FOUND',
              'Conduct Report could not be updated.'
            );
          }

          return {
            resourceSummary: {
              kind: 'CONDUCT_REPORT',
              id: updated.id,
              displayId: formatConductReportDisplayId(updated.publicSequence),
              status: updated.status,
              version: updated.version,
              updatedAt: updated.updatedAt.toISOString(),
              resolvedAt: serializeDate(updated.resolvedAt),
            },
            resourceVersion: updated.version,
            resourceTimestamp: null,
          };
        },
      };
    },
  });
};

export type DecideAdminReportInput = AdminReportCommandInput &
  (
    | { outcome: ReportCaseOutcome; reasonCode?: string; now?: Date }
    | {
        outcome: typeof conductReportStatus.dismissed;
        decisionReasonCode: ConductReportDismissReasonCode;
      }
  );

export type DecideAdminReportResult = AdminActionResult<AdminReportCommandSummary> & {
  outcome: ReportCaseOutcome | typeof conductReportStatus.dismissed;
};

export const decideAdminReport = async (
  input: DecideAdminReportInput
): Promise<DecideAdminReportResult> => {
  if (input.outcome === conductReportStatus.dismissed) {
    const result = await dismissAdminConductReport({
      adminId: input.adminId,
      reportId: input.reportId,
      expectedVersion: input.expectedVersion,
      requestKey: input.requestKey,
      decisionReasonCode: input.decisionReasonCode,
    });
    return { ...result, outcome: input.outcome };
  }

  const result = await decideAdminReportCase({
    adminId: input.adminId,
    reportId: input.reportId,
    expectedVersion: input.expectedVersion,
    requestKey: input.requestKey,
    now: input.now,
    reasonCode: input.reasonCode,
    outcome: input.outcome,
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

const evidenceMessageFrom = (row: EvidenceMessageRow): AdminReportEvidenceMessage => ({
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
): Promise<AdminReportCaseEvidenceWithoutAction> => {
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
    throw new AdminReportError('REPORT_EVIDENCE_NOT_FOUND', 'Report evidence does not exist.');
  }
  if (
    reference.caseStatus !== reportCaseStatus.pending &&
    reference.caseStatus !== reportCaseStatus.hidden
  ) {
    throw new AdminReportError('REPORT_EVIDENCE_NOT_FOUND', 'Report evidence does not exist.');
  }

  if (reference.messageId && reference.messageId !== reference.reportMessageId) {
    throw new AdminReportError('REPORT_EVIDENCE_NOT_FOUND', 'Report evidence does not exist.');
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
      throw new AdminReportError('REPORT_EVIDENCE_NOT_FOUND', 'Report evidence does not exist.');
    }
  }

  const [target] = await selectEvidenceMessageRows(
    database,
    and(eq(chatMessage.id, reference.reportMessageId), isNull(chatMessage.deletedAt)),
    'asc',
    1
  );
  if (!target || target.conversationId !== reference.conversationId) {
    throw new AdminReportError('REPORT_EVIDENCE_NOT_FOUND', 'Report evidence does not exist.');
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
    throw new AdminReportError('REPORT_EVIDENCE_NOT_FOUND', 'Report evidence does not exist.');
  }
  return reference.caseId;
};

export const getAdminReportEvidence = async (
  adminId: string,
  evidenceRefId: string,
  requestKey: string,
  page: AdminReportEvidencePageInput
): Promise<AdminReportEvidenceData> => {
  if (/^CRH_[A-Za-z0-9_-]{43}$/.test(evidenceRefId)) {
    return getConductReportEvidencePage(adminId, evidenceRefId, requestKey, page);
  }

  const reportCaseId = await reportCaseIdForEvidence(evidenceRefId);
  let evidence: AdminReportCaseEvidenceWithoutAction | undefined;
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

type ConductReportEvidenceContext = {
  reportId: string;
  conversationId: string;
  conversationType: 'CONVERSATION_WORK' | 'CONVERSATION_CANDIDATE_INQUIRY';
  expiresAt: Date | null;
};

const conductReportEvidenceContextFor = async (
  database: ReportDatabase,
  evidenceHandle: string
): Promise<ConductReportEvidenceContext> => {
  const [row] = await database
    .select({
      reportId: adminConductReport.id,
      filerUserId: adminConductReport.filerUserId,
      reportedMemberId: adminConductReport.reportedMemberId,
      conversationId: chatConversation.id,
      conversationType: chatConversation.type,
      conversationLatestTerminalAt: chatConversation.latestTerminalAt,
      workLatestTerminalAt: conductReportEvidenceWorkConversation.latestTerminalAt,
      questStatus: quest.questStatus,
      failedAt: quest.failedAt,
      cancelledAt: quest.cancelledAt,
      questUpdatedAt: quest.updatedAt,
    })
    .from(adminConductReportEvidenceHandle)
    .innerJoin(
      adminConductReport,
      eq(adminConductReport.id, adminConductReportEvidenceHandle.reportId)
    )
    .innerJoin(
      chatConversation,
      and(
        eq(chatConversation.id, adminConductReportEvidenceHandle.conversationId),
        eq(chatConversation.questId, adminConductReport.questId)
      )
    )
    .innerJoin(quest, eq(quest.id, adminConductReport.questId))
    .leftJoin(
      conductReportEvidenceWorkConversation,
      and(
        eq(conductReportEvidenceWorkConversation.questId, adminConductReport.questId),
        eq(conductReportEvidenceWorkConversation.type, 'CONVERSATION_WORK'),
        isNull(conductReportEvidenceWorkConversation.deletedAt)
      )
    )
    .where(
      and(
        eq(adminConductReportEvidenceHandle.id, evidenceHandle),
        isNull(chatConversation.deletedAt)
      )
    )
    .limit(1);

  if (!row) {
    throw new AdminReportError('REPORT_EVIDENCE_NOT_FOUND', 'Report evidence does not exist.');
  }

  if (row.conversationType === 'CONVERSATION_CANDIDATE_INQUIRY') {
    const [participant] = await database
      .select({ id: chatMembership.id })
      .from(chatMembership)
      .where(
        and(
          eq(chatMembership.conversationId, row.conversationId),
          inArray(chatMembership.memberId, [row.filerUserId, row.reportedMemberId])
        )
      )
      .limit(1);
    if (!participant) {
      throw new AdminReportError('REPORT_EVIDENCE_NOT_FOUND', 'Report evidence does not exist.');
    }
  } else if (row.conversationType !== 'CONVERSATION_WORK') {
    throw new AdminReportError('REPORT_EVIDENCE_NOT_FOUND', 'Report evidence does not exist.');
  }

  const latestTerminalAt = row.conversationLatestTerminalAt ?? row.workLatestTerminalAt;
  const expiresAt = conductReportEvidenceExpiresAt(
    {
      questStatus: row.questStatus,
      failedAt: row.failedAt,
      cancelledAt: row.cancelledAt,
      updatedAt: row.questUpdatedAt,
    },
    latestTerminalAt
  );
  if (expiresAt && expiresAt <= new Date()) {
    throw new AdminReportError('REPORT_EVIDENCE_NOT_FOUND', 'Report evidence does not exist.');
  }

  return {
    reportId: row.reportId,
    conversationId: row.conversationId,
    conversationType: row.conversationType,
    expiresAt,
  };
};

const conductReportEvidenceCursorAnchor = (
  database: ReportDatabase,
  conversationId: string
): KeysetCursorAnchor => ({
  read: async (cursor) => {
    if (cursor.scope !== conductReportEvidenceCursorScope) return undefined;
    const [row] = await database
      .select({ startTime: chatMessage.createdAt })
      .from(chatMessage)
      .where(
        and(
          eq(chatMessage.id, cursor.id),
          eq(chatMessage.conversationId, conversationId),
          isNull(chatMessage.deletedAt)
        )
      )
      .limit(1);
    return row ? { ...row, id: cursor.id, scope: conductReportEvidenceCursorScope } : undefined;
  },
  boundary: (anchor, sort) => {
    const anchorRow = sql`(
      select ${chatMessage.sequence}, ${chatMessage.id}
      from ${chatMessage}
      where ${chatMessage.id} = ${anchor.id}
        and ${chatMessage.conversationId} = ${conversationId}
        and ${chatMessage.deletedAt} is null
    )`;
    return sort === 'oldest'
      ? sql`(${chatMessage.sequence}, ${chatMessage.id}) > ${anchorRow}`
      : sql`(${chatMessage.sequence}, ${chatMessage.id}) < ${anchorRow}`;
  },
  orderBy: (sort) =>
    sort === 'oldest'
      ? [asc(chatMessage.sequence), asc(chatMessage.id)]
      : [desc(chatMessage.sequence), desc(chatMessage.id)],
});

const conductReportEvidencePageInTransaction = async (
  database: ReportDatabase,
  evidenceHandle: string,
  context: ConductReportEvidenceContext,
  pageInput: AdminReportEvidencePageInput
): Promise<AdminConductReportEvidenceWithoutAction> => {
  const page = await readKeysetPage({
    cursorAnchor: conductReportEvidenceCursorAnchor(database, context.conversationId),
    cursor: pageInput.cursor,
    limit: pageInput.limit,
    sort: 'oldest',
    where: and(
      eq(chatMessage.conversationId, context.conversationId),
      isNull(chatMessage.deletedAt)
    ),
    read: ({ where, limit }) => selectEvidenceMessageRows(database, where, 'asc', limit),
    rowCursor: (row) => ({
      startTime: row.createdAt,
      id: row.id,
      scope: conductReportEvidenceCursorScope,
    }),
    invalidCursor: () => new CursorInputError('INVALID_CURSOR', 'Evidence cursor is invalid.'),
  });

  const messages = page.rows.map(evidenceMessageFrom);
  if (messages.length > 0) {
    const attachmentRows = await database
      .select({
        messageId: chatMessageAttachment.messageId,
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
          inArray(
            chatMessageAttachment.messageId,
            messages.map((message) => message.id)
          ),
          eq(chatAttachment.conversationId, context.conversationId),
          inArray(chatAttachment.status, ['CONSUMED', 'HIDDEN']),
          isNull(chatAttachment.deletedAt)
        )
      )
      .orderBy(asc(chatMessageAttachment.messageId), asc(chatMessageAttachment.position));

    const messageById = new Map(messages.map((message) => [message.id, message]));
    for (const attachment of attachmentRows) {
      const link =
        attachment.bucket &&
        attachment.objectKey &&
        !attachment.attachmentObjectDeletedAt &&
        !attachment.fileObjectDeletedAt &&
        !attachment.fileDeletedAt
          ? workChatStorage.linkForWithExpiry({
              bucket: attachment.bucket,
              objectKey: attachment.objectKey,
            })
          : null;
      messageById.get(attachment.messageId)?.attachments.push({
        id: attachment.id,
        status: attachment.status,
        originalFilename: attachment.originalFilename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        url: link?.url ?? null,
        urlExpiresAt: link?.expiresAt.toISOString() ?? null,
      });
    }
  }

  return {
    conductReportId: context.reportId,
    evidenceHandle,
    conversationType: context.conversationType,
    expiresAt: context.expiresAt?.toISOString() ?? null,
    messages,
    nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
  };
};

const fileAccessRequestKey = (
  requestKey: string,
  evidenceHandle: string,
  attachmentId: string
): string =>
  `CRHF_${createHash('sha256')
    .update(`${requestKey}:${evidenceHandle}:${attachmentId}`)
    .digest('hex')}`;

const recordConductReportFileAccesses = async (
  database: AdminActionTransaction,
  input: {
    adminId: string;
    reportId: string;
    evidenceHandle: string;
    requestKey: string;
    messages: AdminConductReportEvidenceWithoutAction['messages'];
  }
): Promise<void> => {
  for (const message of input.messages) {
    for (const attachment of message.attachments) {
      if (!attachment.url) continue;
      // eslint-disable-next-line no-await-in-loop
      await adminActionService.recordEvidenceAccessInTransaction(database, {
        adminId: input.adminId,
        action: 'CONDUCT_REPORT_EVIDENCE_FILE_ACCESS',
        resourceType: 'conduct_report',
        resourceId: input.reportId,
        requestKey: fileAccessRequestKey(input.requestKey, input.evidenceHandle, attachment.id),
        request: { resourceId: attachment.id, handleId: input.evidenceHandle },
        metadata: { scope: 'conduct-report-file-link' },
        read: async () => ({
          resourceSummary: { resourceId: attachment.id },
          resourceVersion: null,
          resourceTimestamp: null,
        }),
      });
    }
  }
};

const conductReportIdForEvidenceHandle = async (evidenceHandle: string): Promise<string> => {
  const [row] = await db
    .select({ reportId: adminConductReportEvidenceHandle.reportId })
    .from(adminConductReportEvidenceHandle)
    .where(eq(adminConductReportEvidenceHandle.id, evidenceHandle))
    .limit(1);
  if (!row) {
    throw new AdminReportError('REPORT_EVIDENCE_NOT_FOUND', 'Report evidence does not exist.');
  }
  return row.reportId;
};

const getConductReportEvidencePage = async (
  adminId: string,
  evidenceHandle: string,
  requestKey: string,
  pageInput: AdminReportEvidencePageInput
): Promise<AdminConductReportEvidence> => {
  const reportId = await conductReportIdForEvidenceHandle(evidenceHandle);
  let evidence: AdminConductReportEvidenceWithoutAction | undefined;
  const result = await adminActionService.recordEvidenceAccess({
    adminId,
    action: 'CONDUCT_REPORT_EVIDENCE_ACCESS',
    resourceType: 'conduct_report',
    resourceId: reportId,
    requestKey,
    request: {
      view: 'conduct-report-chat-history',
      resourceId: evidenceHandle,
      limit: pageInput.limit,
      cursor: pageInput.cursor ?? null,
    },
    metadata: { scope: 'conduct-report-chat-history' },
    read: async (database) => {
      const context = await conductReportEvidenceContextFor(database, evidenceHandle);
      if (context.reportId !== reportId) {
        throw new AdminReportError('REPORT_EVIDENCE_NOT_FOUND', 'Report evidence does not exist.');
      }
      const loaded = await conductReportEvidencePageInTransaction(
        database,
        evidenceHandle,
        context,
        pageInput
      );
      evidence = loaded;
      await recordConductReportFileAccesses(database, {
        adminId,
        reportId,
        evidenceHandle,
        requestKey,
        messages: loaded.messages,
      });
      return {
        resourceSummary: {
          resourceId: evidenceHandle,
          conversationType: context.conversationType,
          itemCount: loaded.messages.length,
          hasNext: loaded.nextCursor !== null,
        },
        resourceVersion: null,
        resourceTimestamp: null,
      };
    },
  });

  const loaded =
    evidence ??
    (await db.transaction(async (database) => {
      const context = await conductReportEvidenceContextFor(database, evidenceHandle);
      if (context.reportId !== reportId) {
        throw new AdminReportError('REPORT_EVIDENCE_NOT_FOUND', 'Report evidence does not exist.');
      }
      const replayed = await conductReportEvidencePageInTransaction(
        database,
        evidenceHandle,
        context,
        pageInput
      );
      await recordConductReportFileAccesses(database, {
        adminId,
        reportId,
        evidenceHandle,
        requestKey,
        messages: replayed.messages,
      });
      return replayed;
    }));

  return { ...loaded, adminActionId: result.adminActionId };
};
