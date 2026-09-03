import { db } from '@/database/client';
import { adminAction } from '@/database/schema/admin.schema';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';
import {
  proofSubmission,
  proofSubmissionImage,
  quest,
  questApiVersion,
  questApplication,
  questAssignment,
  questConditionItem,
  questEditHistory,
  questEditRequest,
  questEditRequestResponse,
  questTeam,
  questTeamMember,
  questV2EditRequest,
  questV2EditRequestResponse,
  type QuestApiVersion,
} from '@/database/schema/quest.schema';
import type { CursorPayload } from '@/shared/cursor';

import { and, asc, desc, eq, gt, isNotNull, isNull, lt, or } from 'drizzle-orm';

import { questMode, questParticipation, type QuestStatus } from './quest.contract';
import {
  questV2Mode,
  questV2Participation,
  type QuestV2Mode,
  type QuestV2Participation,
} from './quest-v2.contract';
import type { QuestTransaction } from './quest-assignment.service';

export type AdminQuestSort = 'newest' | 'oldest';

export type AdminQuestMember = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
};

type QuestRow = typeof quest.$inferSelect;

const canonicalMode = (row: Pick<QuestRow, 'apiVersion' | 'mode' | 'v2Mode'>): QuestV2Mode =>
  row.apiVersion === questApiVersion.v2 && row.v2Mode
    ? (row.v2Mode as QuestV2Mode)
    : row.mode === questMode.noCandidate
      ? questV2Mode.firstComeFirstServed
      : questV2Mode.candidate;

const canonicalParticipation = (
  row: Pick<QuestRow, 'apiVersion' | 'participation' | 'v2Participation'>,
): QuestV2Participation =>
  row.apiVersion === questApiVersion.v2 && row.v2Participation
    ? (row.v2Participation as QuestV2Participation)
    : row.participation === questParticipation.solo
      ? questV2Participation.single
      : questV2Participation.group;

export type AdminQuestSummary = {
  id: string;
  apiVersion: QuestApiVersion;
  version: number;
  title: string;
  questStatus: QuestStatus;
  mode: QuestV2Mode;
  participation: QuestV2Participation;
  headcount: number;
  rewardSatang: number | null;
  questFundingTotalSatang: number | null;
  startTime: Date;
  dueAt: Date | null;
  hiddenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  hirer: AdminQuestMember;
};

export type AdminQuestSummaryResponse = Omit<
  AdminQuestSummary,
  'startTime' | 'dueAt' | 'hiddenAt' | 'createdAt' | 'updatedAt'
> & {
  startTime: string;
  dueAt: string | null;
  hiddenAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const adminQuestSummaryFromRow = (row: { quest: QuestRow; hirer: AdminQuestMember }): AdminQuestSummary => ({
  id: row.quest.id,
  apiVersion: row.quest.apiVersion,
  version: row.quest.version,
  title: row.quest.title,
  questStatus: row.quest.questStatus as QuestStatus,
  mode: canonicalMode(row.quest),
  participation: canonicalParticipation(row.quest),
  headcount: row.quest.headcount,
  rewardSatang: row.quest.rewardSatang,
  questFundingTotalSatang: row.quest.questFundingTotalSatang,
  startTime: row.quest.startTime,
  dueAt: row.quest.dueAt,
  hiddenAt: row.quest.hiddenAt,
  createdAt: row.quest.createdAt,
  updatedAt: row.quest.updatedAt,
  hirer: row.hirer,
});

export const serializeAdminQuestSummary = (value: AdminQuestSummary): AdminQuestSummaryResponse => ({
  ...value,
  startTime: value.startTime.toISOString(),
  dueAt: value.dueAt ? value.dueAt.toISOString() : null,
  hiddenAt: value.hiddenAt ? value.hiddenAt.toISOString() : null,
  createdAt: value.createdAt.toISOString(),
  updatedAt: value.updatedAt.toISOString(),
});

type AdminQuestExecutor = typeof db | QuestTransaction;

const adminQuestRows = (executor: AdminQuestExecutor) => executor
  .select({
    quest,
    hirer: {
      id: authUser.id,
      firstName: authUser.firstName,
      lastName: authUser.lastName,
      email: authUser.email,
    },
  })
  .from(quest)
  .innerJoin(authUser, eq(authUser.id, quest.hirerId));

export const getAdminQuestSummaryInTransaction = async (
  executor: QuestTransaction,
  questId: string,
): Promise<AdminQuestSummary | undefined> => {
  const [row] = await adminQuestRows(executor)
    .where(eq(quest.id, questId))
    .limit(1);
  return row ? adminQuestSummaryFromRow(row) : undefined;
};

export type ListAdminQuestsInput = {
  status?: QuestStatus;
  mode?: QuestV2Mode;
  participation?: QuestV2Participation;
  hidden?: boolean;
  limit?: number;
  cursor?: CursorPayload;
  sort?: AdminQuestSort;
};

export const listAdminQuests = async ({
  status,
  mode,
  participation,
  hidden,
  limit = 20,
  cursor,
  sort = 'newest',
}: ListAdminQuestsInput = {}) => {
  const cursorDate = cursor ? new Date(cursor.startTime) : undefined;
  const cursorCondition = cursor && cursorDate
    ? sort === 'oldest'
      ? or(
          gt(quest.createdAt, cursorDate),
          and(eq(quest.createdAt, cursorDate), gt(quest.id, cursor.id)),
        )
      : or(
          lt(quest.createdAt, cursorDate),
          and(eq(quest.createdAt, cursorDate), lt(quest.id, cursor.id)),
        )
    : undefined;

  const rows = await adminQuestRows(db)
    .where(and(
      status ? eq(quest.questStatus, status) : undefined,
      mode
        ? eq(quest.mode, mode === questV2Mode.firstComeFirstServed ? questMode.noCandidate : questMode.candidate)
        : undefined,
      participation
        ? eq(
            quest.participation,
            participation === questV2Participation.single ? questParticipation.solo : questParticipation.group,
          )
        : undefined,
      hidden === undefined ? undefined : hidden ? isNotNull(quest.hiddenAt) : isNull(quest.hiddenAt),
      cursorCondition,
    ))
    .orderBy(
      sort === 'oldest' ? asc(quest.createdAt) : desc(quest.createdAt),
      sort === 'oldest' ? asc(quest.id) : desc(quest.id),
    )
    .limit(limit + 1);

  const hasNext = rows.length > limit;
  const items = rows.slice(0, limit).map(adminQuestSummaryFromRow);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasNext && last
      ? { startTime: last.createdAt.toISOString(), id: last.id }
      : null,
  };
};

export type AdminQuestApplication = {
  id: string;
  worker: AdminQuestMember;
  applicationStatus: string;
  reworkLimit: number;
  appliedAt: Date;
};

export type AdminQuestTeam = {
  id: string;
  name: string;
  teamStatus: string;
  reworkLimit: number;
  leaderId: string;
  createdAt: Date;
  members: Array<{ member: AdminQuestMember; joinedAt: Date }>;
};

export type AdminQuestAssignment = {
  id: string;
  worker: AdminQuestMember;
  assignmentStatus: string;
  startedAt: Date | null;
  createdAt: Date;
};

export type AdminQuestProofFile = {
  fileId: string;
  contentType: string;
  sizeBytes: number;
  position: number;
};

export type AdminQuestProof = {
  id: string;
  worker: AdminQuestMember | null;
  team: { id: string; name: string } | null;
  submittedBy: AdminQuestMember;
  content: string;
  submissionStatus: string;
  reviewNote: string | null;
  submittedAt: Date;
  reviewedAt: Date | null;
  files: AdminQuestProofFile[];
};

export type AdminQuestFieldEditEntry = {
  kind: 'FIELD_EDIT';
  id: string;
  fieldName: string;
  oldValue: unknown;
  newValue: unknown;
  editedAt: Date;
  editedByUserId: string | null;
  editedByAdminId: string | null;
};

export type AdminQuestEditRequestEntry = {
  kind: 'EDIT_REQUEST';
  id: string;
  apiVersion: QuestApiVersion;
  requestStatus: string;
  failureCode: string | null;
  requestedByUserId: string | null;
  proposedChanges: unknown;
  createdAt: Date;
  expiresAt: Date | null;
  resolvedAt: Date | null;
  responses: Array<{
    workerId: string;
    decision: string | null;
    reason: string | null;
    respondedAt: Date | null;
  }>;
};

export type AdminQuestEditHistoryEntry = AdminQuestFieldEditEntry | AdminQuestEditRequestEntry;

export type AdminQuestAdminAction = {
  id: string;
  admin: { id: string; firstName: string; lastName: string };
  action: string;
  reasonCode: string | null;
  createdAt: Date;
};

export type AdminQuestDetail = AdminQuestSummary & {
  description: string | null;
  condition: { text: string; items: Array<{ position: number; text: string }> };
  proofRequired: boolean;
  tagId: string | null;
  fundingReservationId: string | null;
  policyRevisionId: string | null;
  platformFeeBps: number | null;
  platformFeePerWorkerSatang: number | null;
  questEscrowSatang: number | null;
  cancelledAt: Date | null;
  cancelledByUserId: string | null;
  cancelledByAdminId: string | null;
  hiddenByAdminId: string | null;
  candidates: {
    applications: AdminQuestApplication[];
    teams: AdminQuestTeam[];
  };
  assignments: AdminQuestAssignment[];
  proofSubmissions: AdminQuestProof[];
  editHistory: AdminQuestEditHistoryEntry[];
  adminActions: AdminQuestAdminAction[];
};

const memberColumns = {
  id: authUser.id,
  firstName: authUser.firstName,
  lastName: authUser.lastName,
  email: authUser.email,
};

const applicationsFor = async (questId: string): Promise<AdminQuestApplication[]> => {
  const rows = await db
    .select({ application: questApplication, worker: memberColumns })
    .from(questApplication)
    .innerJoin(authUser, eq(authUser.id, questApplication.workerId))
    .where(eq(questApplication.questId, questId))
    .orderBy(asc(questApplication.appliedAt));
  return rows.map((row) => ({
    id: row.application.id,
    worker: row.worker,
    applicationStatus: row.application.applicationStatus,
    reworkLimit: row.application.reworkLimit,
    appliedAt: row.application.appliedAt,
  }));
};

const teamsFor = async (questId: string): Promise<AdminQuestTeam[]> => {
  const teams = await db.select().from(questTeam).where(eq(questTeam.questId, questId)).orderBy(asc(questTeam.createdAt));
  return Promise.all(teams.map(async (team) => {
    const members = await db
      .select({ member: memberColumns, joinedAt: questTeamMember.joinedAt })
      .from(questTeamMember)
      .innerJoin(authUser, eq(authUser.id, questTeamMember.userId))
      .where(eq(questTeamMember.teamId, team.id))
      .orderBy(asc(questTeamMember.joinedAt));
    return {
      id: team.id,
      name: team.name,
      teamStatus: team.teamStatus,
      reworkLimit: team.reworkLimit,
      leaderId: team.leaderId,
      createdAt: team.createdAt,
      members,
    };
  }));
};

const assignmentsFor = async (questId: string): Promise<AdminQuestAssignment[]> => {
  const rows = await db
    .select({ assignment: questAssignment, worker: memberColumns })
    .from(questAssignment)
    .innerJoin(authUser, eq(authUser.id, questAssignment.workerId))
    .where(eq(questAssignment.questId, questId))
    .orderBy(asc(questAssignment.createdAt));
  return rows.map((row) => ({
    id: row.assignment.id,
    worker: row.worker,
    assignmentStatus: row.assignment.assignmentStatus,
    startedAt: row.assignment.startedAt,
    createdAt: row.assignment.createdAt,
  }));
};

const proofSubmissionsFor = async (questId: string): Promise<AdminQuestProof[]> => {
  const rows = await db
    .select({
      proof: proofSubmission,
      submittedBy: memberColumns,
    })
    .from(proofSubmission)
    .innerJoin(authUser, eq(authUser.id, proofSubmission.submittedByUserId))
    .where(eq(proofSubmission.questId, questId))
    .orderBy(asc(proofSubmission.submittedAt));

  const workerIds = [...new Set(rows.map((row) => row.proof.workerId).filter((id): id is string => id !== null))];
  const teamIds = [...new Set(rows.map((row) => row.proof.teamId).filter((id): id is string => id !== null))];
  const [workers, teams] = await Promise.all([
    workerIds.length
      ? db.select(memberColumns).from(authUser).where(or(...workerIds.map((id) => eq(authUser.id, id))))
      : Promise.resolve([]),
    teamIds.length
      ? db.select({ id: questTeam.id, name: questTeam.name }).from(questTeam).where(or(...teamIds.map((id) => eq(questTeam.id, id))))
      : Promise.resolve([]),
  ]);
  const workerById = new Map(workers.map((worker) => [worker.id, worker]));
  const teamById = new Map(teams.map((team) => [team.id, team]));

  return Promise.all(rows.map(async (row) => {
    const files = await db
      .select({
        fileId: file.id,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        position: proofSubmissionImage.position,
      })
      .from(proofSubmissionImage)
      .innerJoin(file, eq(file.id, proofSubmissionImage.fileId))
      .where(eq(proofSubmissionImage.proofSubmissionId, row.proof.id))
      .orderBy(asc(proofSubmissionImage.position));
    return {
      id: row.proof.id,
      worker: row.proof.workerId ? (workerById.get(row.proof.workerId) ?? null) : null,
      team: row.proof.teamId ? (teamById.get(row.proof.teamId) ?? null) : null,
      submittedBy: row.submittedBy,
      content: row.proof.content,
      submissionStatus: row.proof.submissionStatus,
      reviewNote: row.proof.reviewNote,
      submittedAt: row.proof.submittedAt,
      reviewedAt: row.proof.reviewedAt,
      files,
    };
  }));
};

const editHistoryFor = async (questId: string): Promise<AdminQuestEditHistoryEntry[]> => {
  const fieldEdits = await db
    .select()
    .from(questEditHistory)
    .where(eq(questEditHistory.questId, questId));
  const fieldEditEntries: AdminQuestFieldEditEntry[] = fieldEdits.map((row) => ({
    kind: 'FIELD_EDIT',
    id: row.id,
    fieldName: row.fieldName,
    oldValue: row.oldValue,
    newValue: row.newValue,
    editedAt: row.editedAt,
    editedByUserId: row.editedByUserId,
    editedByAdminId: row.editedByAdminId,
  }));

  const v1Requests = await db.select().from(questEditRequest).where(eq(questEditRequest.questId, questId));
  const v1Entries: AdminQuestEditRequestEntry[] = await Promise.all(v1Requests.map(async (request) => {
    const responses = await db
      .select()
      .from(questEditRequestResponse)
      .where(eq(questEditRequestResponse.requestId, request.id));
    return {
      kind: 'EDIT_REQUEST' as const,
      id: request.id,
      apiVersion: questApiVersion.v1,
      requestStatus: request.requestStatus,
      failureCode: null,
      requestedByUserId: request.requestedByUserId,
      proposedChanges: request.proposedChanges,
      createdAt: request.createdAt,
      expiresAt: null,
      resolvedAt: request.resolvedAt,
      responses: responses.map((response) => ({
        workerId: response.userId,
        decision: response.decision,
        reason: null,
        respondedAt: response.respondedAt,
      })),
    };
  }));

  const v2Requests = await db.select().from(questV2EditRequest).where(eq(questV2EditRequest.questId, questId));
  const v2Entries: AdminQuestEditRequestEntry[] = await Promise.all(v2Requests.map(async (request) => {
    const responses = await db
      .select()
      .from(questV2EditRequestResponse)
      .where(eq(questV2EditRequestResponse.requestId, request.id));
    return {
      kind: 'EDIT_REQUEST' as const,
      id: request.id,
      apiVersion: questApiVersion.v2,
      requestStatus: request.requestStatus,
      failureCode: request.failureCode,
      requestedByUserId: null,
      proposedChanges: { previousCondition: request.previousCondition, proposedCondition: request.proposedCondition },
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
      resolvedAt: request.appliedAt ?? request.failedAt,
      responses: responses.map((response) => ({
        workerId: response.workerId,
        decision: response.decision,
        reason: response.reason,
        respondedAt: response.respondedAt,
      })),
    };
  }));

  return [...fieldEditEntries, ...v1Entries, ...v2Entries].sort(
    (a, b) => (a.kind === 'FIELD_EDIT' ? a.editedAt : a.createdAt).getTime()
      - (b.kind === 'FIELD_EDIT' ? b.editedAt : b.createdAt).getTime(),
  );
};

const adminActionsFor = async (questId: string): Promise<AdminQuestAdminAction[]> => {
  const rows = await db
    .select({
      action: adminAction,
      admin: { id: authAdmin.id, firstName: authAdmin.firstName, lastName: authAdmin.lastName },
    })
    .from(adminAction)
    .innerJoin(authAdmin, eq(authAdmin.id, adminAction.adminId))
    .where(and(eq(adminAction.resourceType, 'quest'), eq(adminAction.resourceId, questId)))
    .orderBy(asc(adminAction.createdAt));
  return rows.map((row) => ({
    id: row.action.id,
    admin: row.admin,
    action: row.action.action,
    reasonCode: row.action.reasonCode,
    createdAt: row.action.createdAt,
  }));
};

export const getAdminQuestDetail = async (questId: string): Promise<AdminQuestDetail | undefined> => {
  const [row] = await adminQuestRows(db).where(eq(quest.id, questId));
  if (!row) return undefined;

  const [
    conditionItems,
    candidateApplications,
    candidateTeams,
    assignments,
    proofSubmissions,
    editHistory,
    adminActions,
  ] = await Promise.all([
    db
      .select({ position: questConditionItem.position, text: questConditionItem.text })
      .from(questConditionItem)
      .where(eq(questConditionItem.questId, questId))
      .orderBy(asc(questConditionItem.position)),
    applicationsFor(questId),
    teamsFor(questId),
    assignmentsFor(questId),
    proofSubmissionsFor(questId),
    editHistoryFor(questId),
    adminActionsFor(questId),
  ]);

  return {
    ...adminQuestSummaryFromRow(row),
    description: row.quest.description,
    condition: { text: row.quest.condition, items: conditionItems },
    proofRequired: row.quest.proofRequired,
    tagId: row.quest.tagId,
    fundingReservationId: row.quest.fundingReservationId,
    policyRevisionId: row.quest.policyRevisionId,
    platformFeeBps: row.quest.platformFeeBps,
    platformFeePerWorkerSatang: row.quest.platformFeePerWorkerSatang,
    questEscrowSatang: row.quest.questEscrowSatang,
    cancelledAt: row.quest.cancelledAt,
    cancelledByUserId: row.quest.cancelledByUserId,
    cancelledByAdminId: row.quest.cancelledByAdminId,
    hiddenByAdminId: row.quest.hiddenByAdminId,
    candidates: { applications: candidateApplications, teams: candidateTeams },
    assignments,
    proofSubmissions,
    editHistory,
    adminActions,
  };
};

