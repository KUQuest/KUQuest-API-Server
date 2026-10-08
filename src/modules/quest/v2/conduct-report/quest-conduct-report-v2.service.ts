import { db } from '@/database/client';
import {
  adminConductReport,
  type ConductReportReason,
  type ConductReportStatus,
} from '@/database/schema/admin.schema';
import {
  quest,
  questApiVersion,
  questAssignment,
  questCandidateTeamV2,
  questV2CompletionConfirmation,
  questV2ProofSubmission,
} from '@/database/schema/quest.schema';
import { formatConductReportDisplayId } from '@/modules/admin';

import { and, asc, eq, isNotNull } from 'drizzle-orm';

import {
  runQuestCommand,
  sha256Json,
  type QuestCommandOutcomeCode,
  type QuestCommandWork,
} from '../../shared/command/quest-command.service';
import {
  assignmentStatus,
  questStatus,
  type QuestStatus,
} from '../../shared/contracts/quest.contract';
import type { QuestTransaction } from '../../shared/work-chat/quest-work-chat.port';

import type { QuestV2ConductReportCreateInput } from './quest-conduct-report-v2.schema';

type ConductReportExecutor = typeof db | QuestTransaction;

export type QuestV2ConductReportRow = {
  id: string;
  displayId: string;
  questId: string;
  reportedMemberId: string;
  reason: ConductReportReason;
  detail: string | null;
  status: ConductReportStatus;
  createdAt: Date;
};

export type QuestV2Reportable = { memberId: string; reason: ConductReportReason };

export type QuestV2ConductReportView = {
  windowEndsAt: Date | null;
  reportable: QuestV2Reportable[];
  items: QuestV2ConductReportRow[];
};

type ConductReportBusinessOutcomeCode =
  'already-reported' | 'invalid-detail' | 'not-allowed' | 'window-closed';

type ConductReportOutcomeCode =
  ConductReportBusinessOutcomeCode | QuestCommandOutcomeCode | 'not-found';

export type QuestV2ConductReportOutcome =
  QuestV2ConductReportRow | { outcome: ConductReportOutcomeCode };

type QuestRow = {
  hirerId: string;
  questStatus: QuestStatus;
  v2Mode: 'FIRST_COME_FIRST_SERVED' | 'CANDIDATE' | null;
  v2Participation: 'SINGLE' | 'GROUP' | null;
  dueAt: Date | null;
  failedAt: Date | null;
  cancelledAt: Date | null;
  updatedAt: Date;
};

type Eligible = QuestV2Reportable & { assignmentId: string };

const conductReportOperationScope = 'quest.v2.conduct-report.create';
const createConductReportPath = '/api/v2/quests/:questId/conduct-reports';
const filingWindowAfterTerminalMs = 24 * 60 * 60 * 1000;

const reportFields = {
  id: adminConductReport.id,
  publicSequence: adminConductReport.publicSequence,
  questId: adminConductReport.questId,
  reportedMemberId: adminConductReport.reportedMemberId,
  reason: adminConductReport.reason,
  detail: adminConductReport.detail,
  status: adminConductReport.status,
  createdAt: adminConductReport.createdAt,
};

type ReportRecord = {
  id: string;
  publicSequence: number | null;
  questId: string;
  reportedMemberId: string;
  reason: ConductReportReason;
  detail: string | null;
  status: ConductReportStatus;
  createdAt: Date;
};

const toRow = ({ publicSequence, ...record }: ReportRecord): QuestV2ConductReportRow => {
  if (publicSequence === null) throw new Error('Conduct Report has no public sequence');
  return { ...record, displayId: formatConductReportDisplayId(publicSequence) };
};

const loadQuest = async (
  executor: ConductReportExecutor,
  questId: string,
  lock: boolean
): Promise<QuestRow | undefined> => {
  const query = executor
    .select({
      hirerId: quest.hirerId,
      questStatus: quest.questStatus,
      v2Mode: quest.v2Mode,
      v2Participation: quest.v2Participation,
      dueAt: quest.dueAt,
      failedAt: quest.failedAt,
      cancelledAt: quest.cancelledAt,
      updatedAt: quest.updatedAt,
    })
    .from(quest)
    .where(and(eq(quest.id, questId), eq(quest.apiVersion, questApiVersion.v2)))
    .limit(1);
  const [current] = lock ? await query.for('update') : await query;
  return current;
};

/** The completion time is the last Quest write, as for the Rating Review window. */
const terminalAt = (current: QuestRow): Date | null => {
  if (current.questStatus === questStatus.failed) return current.failedAt ?? current.updatedAt;
  if (current.questStatus === questStatus.cancelled) {
    return current.cancelledAt ?? current.updatedAt;
  }
  if (current.questStatus === questStatus.completed) return current.updatedAt;
  return null;
};

const windowEndsAt = (current: QuestRow): Date | null => {
  const at = terminalAt(current);
  return at ? new Date(at.getTime() + filingWindowAfterTerminalMs) : null;
};

/** The filing window opens at QUEST_ASSIGNED and closes 1 day after the Quest becomes Terminal. */
const isWindowOpen = (current: QuestRow, now: Date): boolean => {
  if (current.questStatus === questStatus.assigned) return true;
  if (current.questStatus === questStatus.inProgress) return true;
  const endsAt = windowEndsAt(current);
  return endsAt !== null && now.getTime() <= endsAt.getTime();
};

const loadAssignments = (executor: ConductReportExecutor, questId: string) =>
  executor
    .select({
      id: questAssignment.id,
      workerId: questAssignment.workerId,
      assignmentStatus: questAssignment.assignmentStatus,
    })
    .from(questAssignment)
    .where(eq(questAssignment.questId, questId))
    .orderBy(asc(questAssignment.createdAt), asc(questAssignment.id));

/** Workers and Teams that sent a Proof Submission or made a proof-free confirmation. */
const loadDeliveries = async (executor: ConductReportExecutor, questId: string) => {
  const proofs = await executor
    .select({ workerId: questV2ProofSubmission.workerId, teamId: questV2ProofSubmission.teamId })
    .from(questV2ProofSubmission)
    .where(
      and(eq(questV2ProofSubmission.questId, questId), isNotNull(questV2ProofSubmission.sentAt))
    );
  const confirmations = await executor
    .select({
      workerId: questV2CompletionConfirmation.workerId,
      teamId: questV2CompletionConfirmation.teamId,
    })
    .from(questV2CompletionConfirmation)
    .where(eq(questV2CompletionConfirmation.questId, questId));
  const rows = [...proofs, ...confirmations];
  return {
    workerIds: new Set(rows.flatMap(({ workerId }) => (workerId ? [workerId] : []))),
    teamIds: new Set(rows.flatMap(({ teamId }) => (teamId ? [teamId] : []))),
  };
};

const loadSelectedTeam = async (executor: ConductReportExecutor, questId: string) => {
  const [team] = await executor
    .select({ id: questCandidateTeamV2.id, leaderId: questCandidateTeamV2.leaderId })
    .from(questCandidateTeamV2)
    .where(
      and(
        eq(questCandidateTeamV2.questId, questId),
        eq(questCandidateTeamV2.state, 'TEAM_SELECTED')
      )
    )
    .limit(1);
  return team;
};

const reportedMemberIds = async (executor: ConductReportExecutor, questId: string) =>
  new Set(
    (
      await executor
        .select({ reportedMemberId: adminConductReport.reportedMemberId })
        .from(adminConductReport)
        .where(eq(adminConductReport.questId, questId))
    ).map(({ reportedMemberId }) => reportedMemberId)
  );

/**
 * Lists every Conduct Report the viewer may file on the Quest, ignoring Members already
 * reported. Rules: `admin-conduct-report-contract.md` §Allowed reasons and the Conduct
 * Report rows of `quest-mode-matrix-contract.md`. Missing work exists only once `dueAt` passed.
 */
const eligibleReports = async (
  executor: ConductReportExecutor,
  questId: string,
  current: QuestRow,
  viewerId: string,
  now: Date
): Promise<Eligible[]> => {
  const assignments = await loadAssignments(executor, questId);
  const viewerAssignment = assignments.find(({ workerId }) => workerId === viewerId);
  const isHirer = viewerId === current.hirerId;
  if (!isHirer && !viewerAssignment) return [];

  const dueReached = current.dueAt !== null && now.getTime() >= current.dueAt.getTime();
  const isGroup = current.v2Participation === 'GROUP';
  const isCandidate = current.v2Mode === 'CANDIDATE';
  const deliveries = dueReached ? await loadDeliveries(executor, questId) : undefined;
  const missedWork = assignments.filter(
    ({ workerId, assignmentStatus: status }) =>
      deliveries !== undefined &&
      status !== assignmentStatus.cancelled &&
      !deliveries.workerIds.has(workerId)
  );

  const eligible: Eligible[] = [];
  if (isHirer && deliveries) {
    if (isGroup && isCandidate) {
      const team = await loadSelectedTeam(executor, questId);
      const leader = team && missedWork.find(({ workerId }) => workerId === team.leaderId);
      if (team && leader && !deliveries.teamIds.has(team.id)) {
        eligible.push({
          memberId: leader.workerId,
          reason: 'CONDUCT_ABANDONED',
          assignmentId: leader.id,
        });
      }
    } else {
      for (const { id, workerId } of missedWork) {
        eligible.push({ memberId: workerId, reason: 'CONDUCT_ABANDONED', assignmentId: id });
      }
    }
  }
  if (viewerAssignment) {
    eligible.push({
      memberId: current.hirerId,
      reason: 'CONDUCT_OUT_OF_SCOPE',
      assignmentId: viewerAssignment.id,
    });
    if (isGroup && !isCandidate) {
      for (const { id, workerId } of missedWork) {
        if (workerId === viewerId) continue;
        eligible.push({ memberId: workerId, reason: 'CONDUCT_NO_SHOW', assignmentId: id });
      }
    }
  }
  return eligible;
};

const isParticipant = async (
  executor: ConductReportExecutor,
  questId: string,
  current: QuestRow,
  memberId: string
): Promise<boolean> => {
  if (current.hirerId === memberId) return true;
  const [assignment] = await executor
    .select({ id: questAssignment.id })
    .from(questAssignment)
    .where(and(eq(questAssignment.questId, questId), eq(questAssignment.workerId, memberId)))
    .limit(1);
  return Boolean(assignment);
};

const reportSnapshot = (row: QuestV2ConductReportRow) => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
});

const reportFromSnapshot = (value: unknown): QuestV2ConductReportRow | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const snapshot = value as Record<string, unknown>;
  const createdAt = typeof snapshot.createdAt === 'string' ? new Date(snapshot.createdAt) : null;
  if (
    typeof snapshot.id !== 'string' ||
    typeof snapshot.displayId !== 'string' ||
    typeof snapshot.questId !== 'string' ||
    typeof snapshot.reportedMemberId !== 'string' ||
    typeof snapshot.reason !== 'string' ||
    (snapshot.detail !== null && typeof snapshot.detail !== 'string') ||
    typeof snapshot.status !== 'string' ||
    !createdAt ||
    Number.isNaN(createdAt.getTime())
  )
    return undefined;
  return {
    id: snapshot.id,
    displayId: snapshot.displayId,
    questId: snapshot.questId,
    reportedMemberId: snapshot.reportedMemberId,
    reason: snapshot.reason as ConductReportReason,
    detail: snapshot.detail as string | null,
    status: snapshot.status as ConductReportStatus,
    createdAt,
  };
};

const normalizeDetail = (
  detail: string | undefined
): { value: string | null } | { outcome: 'invalid-detail' } => {
  if (detail === undefined) return { value: null };
  const value = detail.trim();
  return value.length > 0 && value.length <= 1000 ? { value } : { outcome: 'invalid-detail' };
};

export const createQuestV2ConductReport = async (
  filerId: string,
  questId: string,
  input: QuestV2ConductReportCreateInput,
  rawCommandId: string,
  now = new Date()
): Promise<QuestV2ConductReportOutcome> => {
  const requestHash = await sha256Json({
    authenticatedMemberId: filerId,
    operation: conductReportOperationScope,
    path: createConductReportPath,
    questId,
    body: {
      reportedMemberId: input.reportedMemberId,
      reason: input.reason,
      detail: input.detail?.trim() ?? null,
    },
  });

  return db.transaction(async (transaction) => {
    const current = await loadQuest(transaction, questId, true);
    if (!current || !(await isParticipant(transaction, questId, current, filerId))) {
      return { outcome: 'not-found' };
    }

    const command = await runQuestCommand({
      transaction,
      identity: {
        principalUserId: filerId,
        operationScope: conductReportOperationScope,
        key: rawCommandId,
        requestHash,
        questId,
      },
      now,
      work: async (): Promise<
        QuestCommandWork<QuestV2ConductReportRow, ConductReportBusinessOutcomeCode>
      > => {
        const detail = normalizeDetail(input.detail);
        if ('outcome' in detail) return { kind: 'rejected', rejection: detail.outcome };
        if (!isWindowOpen(current, now)) return { kind: 'rejected', rejection: 'window-closed' };
        if ((await reportedMemberIds(transaction, questId)).has(input.reportedMemberId)) {
          return { kind: 'rejected', rejection: 'already-reported' };
        }
        const match = (await eligibleReports(transaction, questId, current, filerId, now)).find(
          ({ memberId, reason }) => memberId === input.reportedMemberId && reason === input.reason
        );
        if (!match) return { kind: 'rejected', rejection: 'not-allowed' };

        const [created] = await transaction
          .insert(adminConductReport)
          .values({
            questId,
            filerUserId: filerId,
            reportedMemberId: match.memberId,
            assignmentId: match.assignmentId,
            reason: match.reason,
            detail: detail.value,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({
            target: [adminConductReport.questId, adminConductReport.reportedMemberId],
          })
          .returning(reportFields);
        if (!created) return { kind: 'rejected', rejection: 'already-reported' };

        const row = toRow(created);
        return {
          kind: 'success',
          result: row,
          resourceType: 'quest-v2-conduct-report',
          resourceId: row.id,
        };
      },
      toSnapshot: reportSnapshot,
      fromSnapshot: reportFromSnapshot,
    });
    if ('outcome' in command) return { outcome: command.outcome };
    if (command.kind === 'success') return command.result;
    return { outcome: command.rejection };
  });
};

export const getQuestV2ConductReportView = async (
  memberId: string,
  questId: string,
  now = new Date()
): Promise<QuestV2ConductReportView | { outcome: 'not-found' }> => {
  const current = await loadQuest(db, questId, false);
  if (!current || !(await isParticipant(db, questId, current, memberId))) {
    return { outcome: 'not-found' };
  }

  const items = (
    await db
      .select(reportFields)
      .from(adminConductReport)
      .where(
        and(eq(adminConductReport.questId, questId), eq(adminConductReport.filerUserId, memberId))
      )
      .orderBy(asc(adminConductReport.createdAt), asc(adminConductReport.id))
  ).map(toRow);

  if (!isWindowOpen(current, now)) {
    return { windowEndsAt: windowEndsAt(current), reportable: [], items };
  }
  const reported = await reportedMemberIds(db, questId);
  const reportable = (await eligibleReports(db, questId, current, memberId, now))
    .filter(({ memberId: reportedId }) => !reported.has(reportedId))
    .map(({ memberId: reportedId, reason }) => ({ memberId: reportedId, reason }));
  return { windowEndsAt: windowEndsAt(current), reportable, items };
};
