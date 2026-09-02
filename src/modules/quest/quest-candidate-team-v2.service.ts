import { db } from '@/database/client';
import { file } from '@/database/schema/file.schema';
import {
  quest,
  questApiVersion,
  questCandidateApplicationV2,
  questAssignment,
  questCandidateTeamV2,
  questCandidateTeamV2Member,
  questCandidateTeamV2SubmissionFile,
} from '@/database/schema/quest.schema';
import { walletIdempotencyKey } from '@/database/schema/wallet.schema';

import { and, asc, eq, exists, inArray, isNull, ne, sql } from 'drizzle-orm';

import {
  getQuestWorkChatMembershipWriter,
  WorkChatTransitionError,
  type QuestTransaction,
} from './quest-work-chat.port';
import type {
  AcceptedWorker,
  QuestWorkChatMembershipTransition,
} from './quest-work-chat.contract';
import {
  questV2AssignmentStates,
  questV2Mode,
  questV2Participation,
  questV2TeamStates,
  type QuestV2AssignmentState,
  type QuestV2TeamState,
} from './quest-v2.contract';
import type {
  QuestV2CandidateTeamCreateInput,
  QuestV2CandidateTeamJoinInput,
  QuestV2CandidateTeamSubmissionInput,
} from './quest-candidate-team-v2.schema';

export const questV2CandidateTeamCreateOperationScope =
  'quest.v2.candidate-team.create';
export const questV2CandidateTeamJoinOperationScope =
  'quest.v2.candidate-team.join';
export const questV2CandidateTeamLeaveOperationScope =
  'quest.v2.candidate-team.leave';
export const questV2CandidateTeamRemoveMemberOperationScope =
  'quest.v2.candidate-team.remove-member';
export const questV2CandidateTeamRegenerateCodeOperationScope =
  'quest.v2.candidate-team.regenerate-code';
export const questV2CandidateTeamSubmitOperationScope =
  'quest.v2.candidate-team.submit';
export const questV2CandidateTeamSelectOperationScope =
  'quest.v2.candidate-team.select';

const dayInMilliseconds = 24 * 60 * 60 * 1000;
const maxAttachmentSizeBytes = 10 * 1024 * 1024;
const joinCodeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const joinCodeLength = 8;
const allowedAttachmentContentTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'video/mp4',
  'video/quicktime',
  'video/webm',
]);

type CandidateTeamMember = {
  memberId: string;
  joinedAt: Date;
};

type CandidateTeamSubmission = {
  text: string;
  fileIds: string[];
  submittedAt: Date;
};

type CandidateTeam = {
  id: string;
  questId: string;
  leaderId: string;
  headcount: number;
  state: QuestV2TeamState;
  joinCode: string | null;
  joinCodeExpiresAt: Date | null;
  members: CandidateTeamMember[];
  submission: CandidateTeamSubmission | null;
  createdAt: Date;
};

type TeamCommandOutcomeCode =
  | 'already-assigned'
  | 'already-member'
  | 'headcount-mismatch'
  | 'headcount-not-allowed'
  | 'hirer-not-allowed'
  | 'idempotency-in-progress'
  | 'idempotency-key-reused'
  | 'idempotency-unavailable'
  | 'invalid-idempotency-key'
  | 'join-code-expired'
  | 'join-code-invalid'
  | 'leader-removal-not-allowed'
  | 'member-not-found'
  | 'not-authorized'
  | 'not-candidate'
  | 'not-forming'
  | 'not-group'
  | 'not-leader'
  | 'not-open'
  | 'not-selectable'
  | 'submission-files-invalid'
  | 'submission-invalid'
  | 'team-full'
  | 'team-not-found'
  | 'not-found';

const teamCommandOutcomeCodes: readonly TeamCommandOutcomeCode[] = [
  'already-assigned',
  'already-member',
  'headcount-mismatch',
  'headcount-not-allowed',
  'hirer-not-allowed',
  'idempotency-in-progress',
  'idempotency-key-reused',
  'idempotency-unavailable',
  'invalid-idempotency-key',
  'join-code-expired',
  'join-code-invalid',
  'leader-removal-not-allowed',
  'member-not-found',
  'not-authorized',
  'not-candidate',
  'not-forming',
  'not-group',
  'not-leader',
  'not-open',
  'not-selectable',
  'submission-files-invalid',
  'submission-invalid',
  'team-full',
  'team-not-found',
  'not-found',
];

export type QuestV2CandidateTeamOutcome =
  | CandidateTeam
  | { outcome: TeamCommandOutcomeCode };

export type QuestV2CandidateTeamReadOutcome =
  | CandidateTeam[]
  | { outcome: 'not-authorized' | 'not-found' };

export type QuestV2CandidateTeamDetailOutcome =
  | CandidateTeam
  | { outcome: 'not-authorized' | 'not-found' | 'team-not-found' };

type SelectionAssignment = {
  id: string;
  questId: string;
  workerId: string;
  state: QuestV2AssignmentState;
  startedAt: Date | null;
  createdAt: Date;
  questState: 'QUEST_ASSIGNED';
};

type SelectionOutcomeCode = Extract<
  TeamCommandOutcomeCode,
  | 'already-assigned'
  | 'idempotency-in-progress'
  | 'idempotency-key-reused'
  | 'idempotency-unavailable'
  | 'invalid-idempotency-key'
  | 'not-authorized'
  | 'not-candidate'
  | 'not-found'
  | 'not-group'
  | 'not-open'
  | 'not-selectable'
  | 'team-not-found'
  | 'headcount-mismatch'
>;

export type QuestV2CandidateTeamSelectionOutcome =
  | {
      assignments: SelectionAssignment[];
      questState: 'QUEST_ASSIGNED';
    }
  | { outcome: SelectionOutcomeCode };

const teamFields = {
  id: questCandidateTeamV2.id,
  questId: questCandidateTeamV2.questId,
  leaderId: questCandidateTeamV2.leaderId,
  headcount: questCandidateTeamV2.headcount,
  state: questCandidateTeamV2.state,
  joinCodeHash: questCandidateTeamV2.joinCodeHash,
  joinCodeExpiresAt: questCandidateTeamV2.joinCodeExpiresAt,
  submissionText: questCandidateTeamV2.submissionText,
  submittedAt: questCandidateTeamV2.submittedAt,
  createdAt: questCandidateTeamV2.createdAt,
};

const assignmentFields = {
  id: questAssignment.id,
  questId: questAssignment.questId,
  workerId: questAssignment.workerId,
  state: questAssignment.assignmentStatus,
  startedAt: questAssignment.startedAt,
  createdAt: questAssignment.createdAt,
};

const idempotencyFields = {
  id: walletIdempotencyKey.id,
  requestHash: walletIdempotencyKey.requestHash,
  resourceId: walletIdempotencyKey.resourceId,
  resultData: walletIdempotencyKey.resultData,
  processingStatus: walletIdempotencyKey.processingStatus,
};

type IdempotencyRecord = {
  id: string;
  requestHash: string;
  resourceId: string | null;
  resultData: unknown;
  processingStatus: string;
};

type IdempotencyAcquireResult =
  | { created: true; record: IdempotencyRecord }
  | { created: false; record: IdempotencyRecord }
  | { outcome: Extract<TeamCommandOutcomeCode, `idempotency-${string}`> };

type Database = typeof db | QuestTransaction;

const sha256Json = async (value: object): Promise<string> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
};

const requestHashFor = (
  operation: string,
  memberId: string,
  path: string,
  body: object,
): Promise<string> => sha256Json({
  authenticatedMemberId: memberId,
  operation,
  path,
  body,
});

const idempotencyExpiry = () => new Date(Date.now() + dayInMilliseconds);

const normalizeJoinCode = (value: string): string => value.trim().toUpperCase();

const generateJoinCode = (): string => {
  const randomValues = new Uint32Array(joinCodeLength);
  crypto.getRandomValues(randomValues);
  return Array.from(
    randomValues,
    (value) => joinCodeAlphabet[value % joinCodeAlphabet.length],
  ).join('');
};

const hashJoinCode = (joinCode: string): Promise<string> => sha256Json({ joinCode });

const isTeamState = (value: string): value is QuestV2TeamState =>
  (questV2TeamStates as readonly string[]).includes(value);

const toCandidateTeam = (
  row: {
    id: string;
    questId: string;
    leaderId: string;
    headcount: number | null;
    state: string;
    joinCodeHash: string | null;
    joinCodeExpiresAt: Date | null;
    submissionText: string | null;
    submittedAt: Date | null;
    createdAt: Date;
  },
  members: CandidateTeamMember[],
  fileIds: string[],
  joinCode: string | null = null,
): CandidateTeam => {
  if (
    row.headcount === null ||
    !Number.isInteger(row.headcount) ||
    row.headcount < 2 ||
    row.headcount > 20
  ) {
    throw new Error('Candidate Team has an invalid headcount');
  }
  if (!isTeamState(row.state)) throw new Error('Candidate Team has an invalid state');
  if ((row.joinCodeHash === null) !== (row.joinCodeExpiresAt === null)) {
    throw new Error('Candidate Team has an invalid Join Code');
  }
  if ((row.submissionText === null) !== (row.submittedAt === null)) {
    throw new Error('Candidate Team has an invalid submission');
  }

  return {
    id: row.id,
    questId: row.questId,
    leaderId: row.leaderId,
    headcount: row.headcount,
    state: row.state,
    joinCode,
    joinCodeExpiresAt: row.joinCodeExpiresAt,
    members,
    submission: row.submissionText === null || row.submittedAt === null
      ? null
      : {
          text: row.submissionText,
          fileIds,
          submittedAt: row.submittedAt,
        },
    createdAt: row.createdAt,
  };
};

const teamMembers = async (
  database: Database,
  teamId: string,
  lock = false,
): Promise<CandidateTeamMember[]> => {
  const query = database
    .select({
      memberId: questCandidateTeamV2Member.memberId,
      joinedAt: questCandidateTeamV2Member.joinedAt,
    })
    .from(questCandidateTeamV2Member)
    .where(eq(questCandidateTeamV2Member.teamId, teamId))
    .orderBy(asc(questCandidateTeamV2Member.joinedAt), asc(questCandidateTeamV2Member.memberId));
  return lock ? query.for('update') : query;
};

const teamSubmissionFileIds = async (
  database: Database,
  teamId: string,
): Promise<string[]> => {
  const rows = await database
    .select({ fileId: questCandidateTeamV2SubmissionFile.fileId })
    .from(questCandidateTeamV2SubmissionFile)
    .where(eq(questCandidateTeamV2SubmissionFile.teamId, teamId))
    .orderBy(asc(questCandidateTeamV2SubmissionFile.position), asc(questCandidateTeamV2SubmissionFile.fileId));
  return rows.map(({ fileId }) => fileId);
};

const readTeam = async (
  database: Database,
  row: {
    id: string;
    questId: string;
    leaderId: string;
    headcount: number | null;
    state: string;
    joinCodeHash: string | null;
    joinCodeExpiresAt: Date | null;
    submissionText: string | null;
    submittedAt: Date | null;
    createdAt: Date;
  },
  joinCode: string | null = null,
): Promise<CandidateTeam> => toCandidateTeam(
  row,
  await teamMembers(database, row.id),
  await teamSubmissionFileIds(database, row.id),
  joinCode,
);

const snapshotFor = (team: CandidateTeam) => ({
  id: team.id,
  questId: team.questId,
  leaderId: team.leaderId,
  headcount: team.headcount,
  state: team.state,
  joinCode: team.joinCode,
  joinCodeExpiresAt: team.joinCodeExpiresAt?.toISOString() ?? null,
  members: team.members.map((member) => ({
    memberId: member.memberId,
    joinedAt: member.joinedAt.toISOString(),
  })),
  submission: team.submission
    ? {
        text: team.submission.text,
        fileIds: team.submission.fileIds,
        submittedAt: team.submission.submittedAt.toISOString(),
      }
    : null,
  createdAt: team.createdAt.toISOString(),
});

const teamFromSnapshot = (value: unknown): CandidateTeam | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const snapshot = value as Record<string, unknown>;
  if (
    typeof snapshot.id !== 'string' ||
    typeof snapshot.questId !== 'string' ||
    typeof snapshot.leaderId !== 'string' ||
    typeof snapshot.headcount !== 'number' ||
    typeof snapshot.state !== 'string' ||
    (snapshot.joinCode !== null && typeof snapshot.joinCode !== 'string') ||
    (snapshot.joinCodeExpiresAt !== null && typeof snapshot.joinCodeExpiresAt !== 'string') ||
    !Array.isArray(snapshot.members) ||
    (snapshot.submission !== null && (typeof snapshot.submission !== 'object' || Array.isArray(snapshot.submission))) ||
    typeof snapshot.createdAt !== 'string' ||
    !isTeamState(snapshot.state)
  ) return undefined;
  if (!Number.isInteger(snapshot.headcount) || snapshot.headcount < 2 || snapshot.headcount > 20) return undefined;

  const joinCodeExpiresAt = snapshot.joinCodeExpiresAt === null
    ? null
    : new Date(snapshot.joinCodeExpiresAt);
  const createdAt = new Date(snapshot.createdAt);
  if (Number.isNaN(createdAt.getTime()) || (joinCodeExpiresAt && Number.isNaN(joinCodeExpiresAt.getTime()))) return undefined;

  const members: CandidateTeamMember[] = [];
  for (const memberValue of snapshot.members) {
    if (!memberValue || typeof memberValue !== 'object' || Array.isArray(memberValue)) return undefined;
    const member = memberValue as Record<string, unknown>;
    if (typeof member.memberId !== 'string' || typeof member.joinedAt !== 'string') return undefined;
    const joinedAt = new Date(member.joinedAt);
    if (Number.isNaN(joinedAt.getTime())) return undefined;
    members.push({ memberId: member.memberId, joinedAt });
  }

  let submission: CandidateTeamSubmission | null = null;
  if (snapshot.submission !== null) {
    const submissionValue = snapshot.submission as Record<string, unknown>;
    if (
      typeof submissionValue.text !== 'string' ||
      !Array.isArray(submissionValue.fileIds) ||
      typeof submissionValue.submittedAt !== 'string' ||
      !submissionValue.fileIds.every((fileId) => typeof fileId === 'string')
    ) return undefined;
    const submittedAt = new Date(submissionValue.submittedAt);
    if (Number.isNaN(submittedAt.getTime())) return undefined;
    submission = {
      text: submissionValue.text,
      fileIds: submissionValue.fileIds as string[],
      submittedAt,
    };
  }

  return {
    id: snapshot.id,
    questId: snapshot.questId,
    leaderId: snapshot.leaderId,
    headcount: snapshot.headcount,
    state: snapshot.state,
    joinCode: snapshot.joinCode,
    joinCodeExpiresAt,
    members,
    submission,
    createdAt,
  };
};

const teamOutcomeFromSnapshot = (value: unknown): QuestV2CandidateTeamOutcome | undefined => {
  const team = teamFromSnapshot(value);
  if (team) return team;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const outcome = (value as Record<string, unknown>).outcome;
  return typeof outcome === 'string' && teamCommandOutcomeCodes.includes(outcome as TeamCommandOutcomeCode)
    ? { outcome: outcome as TeamCommandOutcomeCode }
    : undefined;
};

const selectionAssignmentFromSnapshot = (value: unknown): SelectionAssignment | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const snapshot = value as Record<string, unknown>;
  if (
    typeof snapshot.id !== 'string' ||
    typeof snapshot.questId !== 'string' ||
    typeof snapshot.workerId !== 'string' ||
    typeof snapshot.state !== 'string' ||
    snapshot.questState !== 'QUEST_ASSIGNED' ||
    (snapshot.startedAt !== null && typeof snapshot.startedAt !== 'string') ||
    typeof snapshot.createdAt !== 'string' ||
    !(questV2AssignmentStates as readonly string[]).includes(snapshot.state)
  ) return undefined;
  const startedAt = snapshot.startedAt === null ? null : new Date(snapshot.startedAt);
  const createdAt = new Date(snapshot.createdAt);
  if (Number.isNaN(createdAt.getTime()) || (startedAt && Number.isNaN(startedAt.getTime()))) return undefined;
  return {
    id: snapshot.id,
    questId: snapshot.questId,
    workerId: snapshot.workerId,
    state: snapshot.state as QuestV2AssignmentState,
    startedAt,
    createdAt,
    questState: 'QUEST_ASSIGNED',
  };
};

const selectionSnapshotFor = (result: {
  assignments: SelectionAssignment[];
  questState: 'QUEST_ASSIGNED';
}) => ({
  questState: result.questState,
  assignments: result.assignments.map((assignment) => ({
    id: assignment.id,
    questId: assignment.questId,
    workerId: assignment.workerId,
    state: assignment.state,
    questState: assignment.questState,
    startedAt: assignment.startedAt?.toISOString() ?? null,
    createdAt: assignment.createdAt.toISOString(),
  })),
});

const selectionFromSnapshot = (
  value: unknown,
): QuestV2CandidateTeamSelectionOutcome | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const snapshot = value as Record<string, unknown>;
  const selectionOutcomeCodes: readonly SelectionOutcomeCode[] = [
    'already-assigned',
    'idempotency-in-progress',
    'idempotency-key-reused',
    'idempotency-unavailable',
    'invalid-idempotency-key',
    'not-authorized',
    'not-candidate',
    'not-found',
    'not-group',
    'not-open',
    'not-selectable',
    'team-not-found',
    'headcount-mismatch',
  ];
  if (typeof snapshot.outcome === 'string' && selectionOutcomeCodes.includes(snapshot.outcome as SelectionOutcomeCode)) {
    return { outcome: snapshot.outcome as SelectionOutcomeCode };
  }
  if (snapshot.questState !== 'QUEST_ASSIGNED' || !Array.isArray(snapshot.assignments)) return undefined;
  const assignments: SelectionAssignment[] = [];
  for (const assignmentValue of snapshot.assignments) {
    const assignment = selectionAssignmentFromSnapshot(assignmentValue);
    if (!assignment) return undefined;
    assignments.push(assignment);
  }
  if (assignments.length === 0) return undefined;
  return { assignments, questState: 'QUEST_ASSIGNED' };
};

const lockQuest = async (transaction: QuestTransaction, questId: string) => {
  const [current] = await transaction
    .select({
      hirerId: quest.hirerId,
      v2Mode: quest.v2Mode,
      v2Participation: quest.v2Participation,
      questState: quest.questStatus,
      headcount: quest.headcount,
    })
    .from(quest)
    .where(and(eq(quest.id, questId), eq(quest.apiVersion, questApiVersion.v2)))
    .limit(1)
    .for('update');
  return current;
};

const readableQuest = (current: {
  v2Mode: string | null;
  v2Participation: string | null;
  questState: string;
}) => current.v2Mode === questV2Mode.candidate &&
  current.v2Participation === questV2Participation.group &&
  current.questState === 'QUEST_OPEN';

const acquireIdempotency = async (
  transaction: QuestTransaction,
  memberId: string,
  commandId: string,
  requestHash: string,
  operationScope: string,
): Promise<IdempotencyAcquireResult> => {
  const [created] = await transaction
    .insert(walletIdempotencyKey)
    .values({
      principalUserId: memberId,
      operationScope,
      key: commandId,
      requestHash,
      expiresAt: idempotencyExpiry(),
    })
    .onConflictDoNothing()
    .returning(idempotencyFields);
  if (created) return { created: true, record: created };

  const [existing] = await transaction
    .select(idempotencyFields)
    .from(walletIdempotencyKey)
    .where(and(
      eq(walletIdempotencyKey.principalUserId, memberId),
      eq(walletIdempotencyKey.operationScope, operationScope),
      eq(walletIdempotencyKey.key, commandId),
    ))
    .limit(1)
    .for('update');
  if (!existing) return { outcome: 'idempotency-unavailable' };
  if (existing.requestHash !== requestHash) return { outcome: 'idempotency-key-reused' };
  if (existing.processingStatus === 'COMPLETED') return { created: false, record: existing };
  return { outcome: 'idempotency-in-progress' };
};

const discardIdempotency = async <T extends TeamCommandOutcomeCode>(
  transaction: QuestTransaction,
  idempotencyId: string,
  outcome: T,
  completedAt = new Date(),
): Promise<{ outcome: T }> => {
  await transaction
    .update(walletIdempotencyKey)
    .set({
      resourceType: 'quest-v2-candidate-team',
      resultData: { outcome },
      processingStatus: 'COMPLETED',
      completedAt,
    })
    .where(eq(walletIdempotencyKey.id, idempotencyId));
  return { outcome };
};

const lockTeam = async (
  transaction: QuestTransaction,
  questId: string,
  teamId: string,
) => {
  const [team] = await transaction
    .select(teamFields)
    .from(questCandidateTeamV2)
    .where(and(eq(questCandidateTeamV2.id, teamId), eq(questCandidateTeamV2.questId, questId)))
    .limit(1)
    .for('update');
  return team;
};

const hasTeamMembership = async (
  transaction: QuestTransaction,
  questId: string,
  memberId: string,
): Promise<boolean> => {
  const [membership] = await transaction
    .select({ teamId: questCandidateTeamV2Member.teamId })
    .from(questCandidateTeamV2Member)
    .innerJoin(questCandidateTeamV2, eq(questCandidateTeamV2Member.teamId, questCandidateTeamV2.id))
    .where(and(
      eq(questCandidateTeamV2.questId, questId),
      eq(questCandidateTeamV2Member.memberId, memberId),
      ne(questCandidateTeamV2.state, 'TEAM_DISBANDED'),
    ))
    .limit(1)
    .for('update');
  return Boolean(membership);
};

const hasActiveAssignment = async (
  transaction: QuestTransaction,
  questId: string,
  memberId: string,
): Promise<boolean> => {
  const [assignment] = await transaction
    .select({ id: questAssignment.id })
    .from(questAssignment)
    .where(and(
      eq(questAssignment.questId, questId),
      eq(questAssignment.workerId, memberId),
      eq(questAssignment.assignmentStatus, 'ASSIGNMENT_ACTIVE'),
    ))
    .limit(1)
    .for('update');
  return Boolean(assignment);
};

const validTeamHeadcount = (headcount: number, questHeadcount: number): boolean =>
  Number.isInteger(headcount) && headcount >= 2 && headcount <= questHeadcount;

const completeTeamCommand = async (
  transaction: QuestTransaction,
  idempotencyId: string,
  team: CandidateTeam,
  resourceType: string,
  completedAt: Date,
) => {
  await transaction
    .update(walletIdempotencyKey)
    .set({
      resourceType,
      resourceId: team.id,
      resultData: snapshotFor(team),
      processingStatus: 'COMPLETED',
      completedAt,
    })
    .where(eq(walletIdempotencyKey.id, idempotencyId));
};

const validateSubmissionFiles = async (
  transaction: QuestTransaction,
  memberId: string,
  fileIds: string[],
): Promise<boolean> => {
  if (fileIds.length === 0 || new Set(fileIds).size !== fileIds.length) return false;
  const rows = await transaction
    .select({
      id: file.id,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
    })
    .from(file)
    .where(and(
      inArray(file.id, fileIds),
      eq(file.uploadedByUserId, memberId),
      isNull(file.deletedAt),
    ));
  if (rows.length !== fileIds.length) return false;
  return rows.every((row) =>
    allowedAttachmentContentTypes.has(row.contentType) &&
    row.sizeBytes > 0 &&
    row.sizeBytes <= maxAttachmentSizeBytes,
  );
};

const completeSelectionCommand = async (
  transaction: QuestTransaction,
  idempotencyId: string,
  teamId: string,
  result: { assignments: SelectionAssignment[]; questState: 'QUEST_ASSIGNED' },
  completedAt: Date,
) => {
  await transaction
    .update(walletIdempotencyKey)
    .set({
      resourceType: 'quest-v2-candidate-team-selection',
      resourceId: teamId,
      resultData: selectionSnapshotFor(result),
      processingStatus: 'COMPLETED',
      completedAt,
    })
    .where(eq(walletIdempotencyKey.id, idempotencyId));
};

export const createQuestV2CandidateTeam = async (
  leaderId: string,
  questId: string,
  input: QuestV2CandidateTeamCreateInput,
  rawCommandId: string,
  now = new Date(),
): Promise<QuestV2CandidateTeamOutcome> => {
  const commandId = rawCommandId.trim();
  if (commandId.length === 0 || commandId.length > 200) return { outcome: 'invalid-idempotency-key' };
  const requestHash = await requestHashFor(
    questV2CandidateTeamCreateOperationScope,
    leaderId,
    '/api/v2/quests/:questId/teams',
    { questId, headcount: input.headcount },
  );

  return db.transaction(async (transaction) => {
    const current = await lockQuest(transaction, questId);
    if (!current) return { outcome: 'not-found' };
    const idempotency = await acquireIdempotency(
      transaction,
      leaderId,
      commandId,
      requestHash,
      questV2CandidateTeamCreateOperationScope,
    );
    if ('outcome' in idempotency) return idempotency;
    if (!idempotency.created) {
      const replay = teamOutcomeFromSnapshot(idempotency.record.resultData);
      return replay ?? { outcome: 'idempotency-unavailable' };
    }

    if (current.v2Mode !== questV2Mode.candidate) return discardIdempotency(transaction, idempotency.record.id, 'not-candidate');
    if (current.v2Participation !== questV2Participation.group) return discardIdempotency(transaction, idempotency.record.id, 'not-group');
    if (current.hirerId === leaderId) return discardIdempotency(transaction, idempotency.record.id, 'hirer-not-allowed');
    if (current.questState !== 'QUEST_OPEN') return discardIdempotency(transaction, idempotency.record.id, 'not-open');
    if (!validTeamHeadcount(input.headcount, current.headcount)) return discardIdempotency(transaction, idempotency.record.id, 'headcount-not-allowed');
    if (await hasActiveAssignment(transaction, questId, leaderId)) return discardIdempotency(transaction, idempotency.record.id, 'already-assigned');
    if (await hasTeamMembership(transaction, questId, leaderId)) return discardIdempotency(transaction, idempotency.record.id, 'already-member');

    const joinCode = generateJoinCode();
    const joinCodeExpiresAt = new Date(now.getTime() + dayInMilliseconds);
    const [createdTeam] = await transaction
      .insert(questCandidateTeamV2)
      .values({
        questId,
        leaderId,
        headcount: input.headcount,
        state: 'TEAM_FORMING',
        joinCodeHash: await hashJoinCode(joinCode),
        joinCodeExpiresAt,
        createdAt: now,
      })
      .returning(teamFields);
    if (!createdTeam) return { outcome: 'idempotency-unavailable' };

    await transaction.insert(questCandidateTeamV2Member).values({
      teamId: createdTeam.id,
      memberId: leaderId,
      joinedAt: now,
    });
    const team = await readTeam(transaction, createdTeam, joinCode);
    await completeTeamCommand(
      transaction,
      idempotency.record.id,
      team,
      'quest-v2-candidate-team',
      now,
    );
    return team;
  });
};

export const listQuestV2CandidateTeams = async (
  memberId: string,
  questId: string,
): Promise<QuestV2CandidateTeamReadOutcome> => {
  const [current] = await db
    .select({
      hirerId: quest.hirerId,
      v2Mode: quest.v2Mode,
      v2Participation: quest.v2Participation,
      questState: quest.questStatus,
    })
    .from(quest)
    .where(and(eq(quest.id, questId), eq(quest.apiVersion, questApiVersion.v2)))
    .limit(1);
  if (!current || !readableQuest(current)) return { outcome: 'not-found' };

  const rows = await db
    .select(teamFields)
    .from(questCandidateTeamV2)
    .where(and(
      eq(questCandidateTeamV2.questId, questId),
      ne(questCandidateTeamV2.state, 'TEAM_DISBANDED'),
      ...(current.hirerId === memberId
        ? []
        : [exists(sql`(
          select 1
          from quest_candidate_team_v2_member member
          where member.team_id = ${questCandidateTeamV2.id}
            and member.member_id = ${memberId}
        )`)]),
    ))
    .orderBy(asc(questCandidateTeamV2.createdAt), asc(questCandidateTeamV2.id));
  if (current.hirerId !== memberId && rows.length === 0) return { outcome: 'not-authorized' };
  return Promise.all(rows.map((row) => readTeam(db, row)));
};

export const getQuestV2CandidateTeam = async (
  memberId: string,
  questId: string,
  teamId: string,
): Promise<QuestV2CandidateTeamDetailOutcome> => {
  const [current] = await db
    .select({
      hirerId: quest.hirerId,
      v2Mode: quest.v2Mode,
      v2Participation: quest.v2Participation,
      questState: quest.questStatus,
    })
    .from(quest)
    .where(and(eq(quest.id, questId), eq(quest.apiVersion, questApiVersion.v2)))
    .limit(1);
  if (!current || !readableQuest(current)) return { outcome: 'not-found' };

  const [row] = await db
    .select(teamFields)
    .from(questCandidateTeamV2)
    .where(and(
      eq(questCandidateTeamV2.id, teamId),
      eq(questCandidateTeamV2.questId, questId),
      ne(questCandidateTeamV2.state, 'TEAM_DISBANDED'),
      ...(current.hirerId === memberId
        ? []
        : [exists(sql`(
          select 1
          from quest_candidate_team_v2_member member
          where member.team_id = ${questCandidateTeamV2.id}
            and member.member_id = ${memberId}
        )`)]),
    ))
    .limit(1);
  if (!row) return current.hirerId === memberId
    ? { outcome: 'team-not-found' }
    : { outcome: 'not-authorized' };
  return readTeam(db, row);
};

export const joinQuestV2CandidateTeam = async (
  memberId: string,
  questId: string,
  teamId: string,
  input: QuestV2CandidateTeamJoinInput,
  rawCommandId: string,
  now = new Date(),
): Promise<QuestV2CandidateTeamOutcome> => {
  const commandId = rawCommandId.trim();
  if (commandId.length === 0 || commandId.length > 200) return { outcome: 'invalid-idempotency-key' };
  const joinCode = normalizeJoinCode(input.joinCode);
  const requestHash = await requestHashFor(
    questV2CandidateTeamJoinOperationScope,
    memberId,
    '/api/v2/quests/:questId/teams/:teamId/join',
    { questId, teamId, joinCode },
  );

  return db.transaction(async (transaction) => {
    const current = await lockQuest(transaction, questId);
    if (!current) return { outcome: 'not-found' };
    const idempotency = await acquireIdempotency(
      transaction,
      memberId,
      commandId,
      requestHash,
      questV2CandidateTeamJoinOperationScope,
    );
    if ('outcome' in idempotency) return idempotency;
    if (!idempotency.created) {
      const replay = teamOutcomeFromSnapshot(idempotency.record.resultData);
      return replay ?? { outcome: 'idempotency-unavailable' };
    }

    if (current.v2Mode !== questV2Mode.candidate) return discardIdempotency(transaction, idempotency.record.id, 'not-candidate');
    if (current.v2Participation !== questV2Participation.group) return discardIdempotency(transaction, idempotency.record.id, 'not-group');
    if (current.hirerId === memberId) return discardIdempotency(transaction, idempotency.record.id, 'hirer-not-allowed');
    if (current.questState !== 'QUEST_OPEN') return discardIdempotency(transaction, idempotency.record.id, 'not-open');

    const team = await lockTeam(transaction, questId, teamId);
    if (!team) return discardIdempotency(transaction, idempotency.record.id, 'team-not-found');
    if (team.state !== 'TEAM_FORMING') return discardIdempotency(transaction, idempotency.record.id, 'not-forming');
    if (!team.joinCodeHash || !team.joinCodeExpiresAt) return discardIdempotency(transaction, idempotency.record.id, 'join-code-invalid');
    if (team.joinCodeExpiresAt.getTime() <= now.getTime()) return discardIdempotency(transaction, idempotency.record.id, 'join-code-expired');
    if (await hashJoinCode(joinCode) !== team.joinCodeHash) return discardIdempotency(transaction, idempotency.record.id, 'join-code-invalid');

    const members = await teamMembers(transaction, teamId, true);
    if (members.length >= (team.headcount ?? 0)) return discardIdempotency(transaction, idempotency.record.id, 'team-full');
    if (await hasActiveAssignment(transaction, questId, memberId)) return discardIdempotency(transaction, idempotency.record.id, 'already-assigned');
    if (await hasTeamMembership(transaction, questId, memberId)) return discardIdempotency(transaction, idempotency.record.id, 'already-member');

    await transaction.insert(questCandidateTeamV2Member).values({
      teamId,
      memberId,
      joinedAt: now,
    });
    const result = await readTeam(transaction, team);
    await completeTeamCommand(
      transaction,
      idempotency.record.id,
      result,
      'quest-v2-candidate-team',
      now,
    );
    return result;
  });
};

const leaveOrRemoveTeamMember = async (
  memberId: string,
  questId: string,
  teamId: string,
  rawCommandId: string,
  operationScope: string,
  path: string,
  removeMemberId: string | undefined,
  now: Date,
): Promise<QuestV2CandidateTeamOutcome> => {
  const commandId = rawCommandId.trim();
  if (commandId.length === 0 || commandId.length > 200) return { outcome: 'invalid-idempotency-key' };
  const requestHash = await requestHashFor(
    operationScope,
    memberId,
    path,
    { questId, teamId, ...(removeMemberId ? { memberId: removeMemberId } : {}) },
  );

  return db.transaction(async (transaction) => {
    const current = await lockQuest(transaction, questId);
    if (!current) return { outcome: 'not-found' };
    const idempotency = await acquireIdempotency(
      transaction,
      memberId,
      commandId,
      requestHash,
      operationScope,
    );
    if ('outcome' in idempotency) return idempotency;
    if (!idempotency.created) {
      const replay = teamOutcomeFromSnapshot(idempotency.record.resultData);
      return replay ?? { outcome: 'idempotency-unavailable' };
    }

    if (current.v2Mode !== questV2Mode.candidate) return discardIdempotency(transaction, idempotency.record.id, 'not-candidate');
    if (current.v2Participation !== questV2Participation.group) return discardIdempotency(transaction, idempotency.record.id, 'not-group');
    if (current.questState !== 'QUEST_OPEN') return discardIdempotency(transaction, idempotency.record.id, 'not-open');

    const team = await lockTeam(transaction, questId, teamId);
    if (!team) return discardIdempotency(transaction, idempotency.record.id, 'team-not-found');
    if (team.state !== 'TEAM_FORMING') return discardIdempotency(transaction, idempotency.record.id, 'not-forming');
    const members = await teamMembers(transaction, teamId, true);

    if (removeMemberId === undefined) {
      if (!members.some((member) => member.memberId === memberId)) return discardIdempotency(transaction, idempotency.record.id, 'member-not-found');
      await transaction
        .delete(questCandidateTeamV2Member)
        .where(and(eq(questCandidateTeamV2Member.teamId, teamId), eq(questCandidateTeamV2Member.memberId, memberId)));
    } else {
      if (team.leaderId !== memberId) return discardIdempotency(transaction, idempotency.record.id, 'not-leader');
      if (removeMemberId === memberId) return discardIdempotency(transaction, idempotency.record.id, 'leader-removal-not-allowed');
      if (!members.some((member) => member.memberId === removeMemberId)) return discardIdempotency(transaction, idempotency.record.id, 'member-not-found');
      await transaction
        .delete(questCandidateTeamV2Member)
        .where(and(eq(questCandidateTeamV2Member.teamId, teamId), eq(questCandidateTeamV2Member.memberId, removeMemberId)));
    }

    const remaining = members.filter((member) => member.memberId !== (removeMemberId ?? memberId));
    let updatedTeam = team;
    if (remaining.length === 0) {
      const [disbanded] = await transaction
        .update(questCandidateTeamV2)
        .set({
          state: 'TEAM_DISBANDED',
          joinCodeHash: null,
          joinCodeExpiresAt: null,
        })
        .where(eq(questCandidateTeamV2.id, teamId))
        .returning(teamFields);
      if (!disbanded) return { outcome: 'idempotency-unavailable' };
      updatedTeam = disbanded;
    } else if (removeMemberId === undefined && team.leaderId === memberId) {
      const [transferred] = await transaction
        .update(questCandidateTeamV2)
        .set({ leaderId: remaining[0]!.memberId })
        .where(eq(questCandidateTeamV2.id, teamId))
        .returning(teamFields);
      if (!transferred) return { outcome: 'idempotency-unavailable' };
      updatedTeam = transferred;
    }

    const result = await readTeam(transaction, updatedTeam);
    await completeTeamCommand(
      transaction,
      idempotency.record.id,
      result,
      'quest-v2-candidate-team',
      now,
    );
    return result;
  });
};

export const leaveQuestV2CandidateTeam = (
  memberId: string,
  questId: string,
  teamId: string,
  rawCommandId: string,
  now = new Date(),
): Promise<QuestV2CandidateTeamOutcome> => leaveOrRemoveTeamMember(
  memberId,
  questId,
  teamId,
  rawCommandId,
  questV2CandidateTeamLeaveOperationScope,
  '/api/v2/quests/:questId/teams/:teamId/leave',
  undefined,
  now,
);

export const removeQuestV2CandidateTeamMember = (
  leaderId: string,
  questId: string,
  teamId: string,
  memberId: string,
  rawCommandId: string,
  now = new Date(),
): Promise<QuestV2CandidateTeamOutcome> => leaveOrRemoveTeamMember(
  leaderId,
  questId,
  teamId,
  rawCommandId,
  questV2CandidateTeamRemoveMemberOperationScope,
  '/api/v2/quests/:questId/teams/:teamId/members/:memberId',
  memberId,
  now,
);

export const regenerateQuestV2CandidateTeamJoinCode = async (
  leaderId: string,
  questId: string,
  teamId: string,
  rawCommandId: string,
  now = new Date(),
): Promise<QuestV2CandidateTeamOutcome> => {
  const commandId = rawCommandId.trim();
  if (commandId.length === 0 || commandId.length > 200) return { outcome: 'invalid-idempotency-key' };
  const requestHash = await requestHashFor(
    questV2CandidateTeamRegenerateCodeOperationScope,
    leaderId,
    '/api/v2/quests/:questId/teams/:teamId/join-code',
    { questId, teamId },
  );

  return db.transaction(async (transaction) => {
    const current = await lockQuest(transaction, questId);
    if (!current) return { outcome: 'not-found' };
    const idempotency = await acquireIdempotency(
      transaction,
      leaderId,
      commandId,
      requestHash,
      questV2CandidateTeamRegenerateCodeOperationScope,
    );
    if ('outcome' in idempotency) return idempotency;
    if (!idempotency.created) {
      const replay = teamOutcomeFromSnapshot(idempotency.record.resultData);
      return replay ?? { outcome: 'idempotency-unavailable' };
    }

    if (current.v2Mode !== questV2Mode.candidate) return discardIdempotency(transaction, idempotency.record.id, 'not-candidate');
    if (current.v2Participation !== questV2Participation.group) return discardIdempotency(transaction, idempotency.record.id, 'not-group');
    if (current.questState !== 'QUEST_OPEN') return discardIdempotency(transaction, idempotency.record.id, 'not-open');
    const team = await lockTeam(transaction, questId, teamId);
    if (!team) return discardIdempotency(transaction, idempotency.record.id, 'team-not-found');
    if (team.leaderId !== leaderId) return discardIdempotency(transaction, idempotency.record.id, 'not-leader');
    if (team.state !== 'TEAM_FORMING') return discardIdempotency(transaction, idempotency.record.id, 'not-forming');

    const joinCode = generateJoinCode();
    const [updatedTeam] = await transaction
      .update(questCandidateTeamV2)
      .set({
        joinCodeHash: await hashJoinCode(joinCode),
        joinCodeExpiresAt: new Date(now.getTime() + dayInMilliseconds),
      })
      .where(eq(questCandidateTeamV2.id, teamId))
      .returning(teamFields);
    if (!updatedTeam) return { outcome: 'idempotency-unavailable' };
    const result = await readTeam(transaction, updatedTeam, joinCode);
    await completeTeamCommand(
      transaction,
      idempotency.record.id,
      result,
      'quest-v2-candidate-team',
      now,
    );
    return result;
  });
};

export const submitQuestV2CandidateTeam = async (
  leaderId: string,
  questId: string,
  teamId: string,
  input: QuestV2CandidateTeamSubmissionInput,
  rawCommandId: string,
  now = new Date(),
): Promise<QuestV2CandidateTeamOutcome> => {
  const commandId = rawCommandId.trim();
  if (commandId.length === 0 || commandId.length > 200) return { outcome: 'invalid-idempotency-key' };
  const text = input.text.trim();
  const requestHash = await requestHashFor(
    questV2CandidateTeamSubmitOperationScope,
    leaderId,
    '/api/v2/quests/:questId/teams/:teamId/submit',
    { questId, teamId, text, fileIds: input.fileIds },
  );

  return db.transaction(async (transaction) => {
    const current = await lockQuest(transaction, questId);
    if (!current) return { outcome: 'not-found' };
    const idempotency = await acquireIdempotency(
      transaction,
      leaderId,
      commandId,
      requestHash,
      questV2CandidateTeamSubmitOperationScope,
    );
    if ('outcome' in idempotency) return idempotency;
    if (!idempotency.created) {
      const replay = teamOutcomeFromSnapshot(idempotency.record.resultData);
      return replay ?? { outcome: 'idempotency-unavailable' };
    }

    if (current.v2Mode !== questV2Mode.candidate) return discardIdempotency(transaction, idempotency.record.id, 'not-candidate');
    if (current.v2Participation !== questV2Participation.group) return discardIdempotency(transaction, idempotency.record.id, 'not-group');
    if (current.questState !== 'QUEST_OPEN') return discardIdempotency(transaction, idempotency.record.id, 'not-open');
    const team = await lockTeam(transaction, questId, teamId);
    if (!team) return discardIdempotency(transaction, idempotency.record.id, 'team-not-found');
    if (team.leaderId !== leaderId) return discardIdempotency(transaction, idempotency.record.id, 'not-leader');
    if (team.state !== 'TEAM_FORMING') return discardIdempotency(transaction, idempotency.record.id, 'not-forming');
    const members = await teamMembers(transaction, teamId, true);
    if (team.headcount === null || members.length !== team.headcount) return discardIdempotency(transaction, idempotency.record.id, 'headcount-mismatch');
    if (!text || text.length > 1000) return discardIdempotency(transaction, idempotency.record.id, 'submission-invalid');
    if (!(await validateSubmissionFiles(transaction, leaderId, input.fileIds))) return discardIdempotency(transaction, idempotency.record.id, 'submission-files-invalid');

    const [usedFile] = await transaction
      .select({ fileId: questCandidateTeamV2SubmissionFile.fileId })
      .from(questCandidateTeamV2SubmissionFile)
      .where(inArray(questCandidateTeamV2SubmissionFile.fileId, input.fileIds))
      .limit(1);
    if (usedFile) return discardIdempotency(transaction, idempotency.record.id, 'submission-files-invalid');

    const [updatedTeam] = await transaction
      .update(questCandidateTeamV2)
      .set({
        state: 'TEAM_SUBMITTED',
        joinCodeHash: null,
        joinCodeExpiresAt: null,
        submissionText: text,
        submittedAt: now,
      })
      .where(and(eq(questCandidateTeamV2.id, teamId), eq(questCandidateTeamV2.state, 'TEAM_FORMING')))
      .returning(teamFields);
    if (!updatedTeam) return { outcome: 'idempotency-unavailable' };
    await transaction.insert(questCandidateTeamV2SubmissionFile).values(
      input.fileIds.map((fileId, position) => ({ teamId, fileId, position, attachedAt: now })),
    );
    const result = await readTeam(transaction, updatedTeam);
    await completeTeamCommand(
      transaction,
      idempotency.record.id,
      result,
      'quest-v2-candidate-team',
      now,
    );
    return result;
  });
};

const toSelectionAssignment = (row: {
  id: string;
  questId: string;
  workerId: string;
  state: string;
  startedAt: Date | null;
  createdAt: Date;
}): SelectionAssignment => {
  if (!(questV2AssignmentStates as readonly string[]).includes(row.state)) {
    throw new Error('Assignment has an invalid state for Quest API V2');
  }
  return {
    ...row,
    state: row.state as QuestV2AssignmentState,
    questState: 'QUEST_ASSIGNED',
  };
};

const selectionTransitionFor = (
  questId: string,
  hirerId: string,
  teamId: string,
  now: Date,
  assignments: SelectionAssignment[],
): QuestWorkChatMembershipTransition => {
  const workers = assignments.map<AcceptedWorker>((assignment) => ({
    workerId: assignment.workerId,
    assignmentId: assignment.id,
    joinedAt: assignment.createdAt.toISOString(),
  }));
  const [firstWorker, ...otherWorkers] = workers;
  if (!firstWorker) throw new Error('Candidate Team selection has no Workers');
  return {
    producer: 'QUEST_CANDIDATE_SELECTION',
    type: 'workersAccepted',
    commandId: `quest-candidate-team-selection-v2:${teamId}`,
    eventId: teamId,
    questId,
    actorId: hirerId,
    occurredAt: now.toISOString(),
    hirerId,
    workers: [firstWorker, ...otherWorkers],
  };
};

export const selectQuestV2CandidateTeam = async (
  hirerId: string,
  questId: string,
  teamId: string,
  rawCommandId: string,
  now = new Date(),
): Promise<QuestV2CandidateTeamSelectionOutcome> => {
  const commandId = rawCommandId.trim();
  if (commandId.length === 0 || commandId.length > 200) return { outcome: 'invalid-idempotency-key' };
  const requestHash = await requestHashFor(
    questV2CandidateTeamSelectOperationScope,
    hirerId,
    '/api/v2/quests/:questId/teams/:teamId/select',
    { questId, teamId },
  );

  return db.transaction(async (transaction) => {
    const current = await lockQuest(transaction, questId);
    if (!current) return { outcome: 'not-found' };
    const idempotency = await acquireIdempotency(
      transaction,
      hirerId,
      commandId,
      requestHash,
      questV2CandidateTeamSelectOperationScope,
    );
    if ('outcome' in idempotency) return idempotency;
    if (!idempotency.created) return selectionFromSnapshot(idempotency.record.resultData) ?? { outcome: 'idempotency-unavailable' };

    if (current.hirerId !== hirerId) return discardIdempotency(transaction, idempotency.record.id, 'not-authorized');
    if (current.v2Mode !== questV2Mode.candidate) return discardIdempotency(transaction, idempotency.record.id, 'not-candidate');
    if (current.v2Participation !== questV2Participation.group) return discardIdempotency(transaction, idempotency.record.id, 'not-group');
    if (current.questState !== 'QUEST_OPEN') return discardIdempotency(transaction, idempotency.record.id, 'not-open');

    const team = await lockTeam(transaction, questId, teamId);
    if (!team) return discardIdempotency(transaction, idempotency.record.id, 'team-not-found');
    if (team.state !== 'TEAM_SUBMITTED') return discardIdempotency(transaction, idempotency.record.id, 'not-selectable');
    if (team.headcount === null) return discardIdempotency(transaction, idempotency.record.id, 'headcount-mismatch');
    const members = await teamMembers(transaction, teamId, true);
    if (members.length !== team.headcount) return discardIdempotency(transaction, idempotency.record.id, 'headcount-mismatch');

    const existingAssignments = await transaction
      .select(assignmentFields)
      .from(questAssignment)
      .where(eq(questAssignment.questId, questId))
      .for('update');
    const memberIds = members.map((member) => member.memberId);
    if (existingAssignments.some((assignment) => memberIds.includes(assignment.workerId))) {
      return discardIdempotency(transaction, idempotency.record.id, 'already-assigned');
    }

    await transaction
      .update(questCandidateTeamV2)
      .set({ state: 'TEAM_SELECTED' })
      .where(and(eq(questCandidateTeamV2.id, teamId), eq(questCandidateTeamV2.state, 'TEAM_SUBMITTED')));
    await transaction
      .update(questCandidateTeamV2)
      .set({ state: 'TEAM_REJECTED' })
      .where(and(
        eq(questCandidateTeamV2.questId, questId),
        eq(questCandidateTeamV2.state, 'TEAM_SUBMITTED'),
        ne(questCandidateTeamV2.id, teamId),
      ));
    await transaction
      .update(questCandidateApplicationV2)
      .set({ state: 'APPLICATION_REJECTED' })
      .where(and(
        eq(questCandidateApplicationV2.questId, questId),
        eq(questCandidateApplicationV2.state, 'APPLICATION_APPLIED'),
      ));

    const createdAssignments = await transaction
      .insert(questAssignment)
      .values(memberIds.map((workerId) => ({
        questId,
        workerId,
        assignmentStatus: 'ASSIGNMENT_ACTIVE',
        createdAt: now,
      })))
      .returning(assignmentFields);
    if (createdAssignments.length !== memberIds.length) return { outcome: 'idempotency-unavailable' };
    const assignmentByWorkerId = new Map(createdAssignments.map((assignment) => [assignment.workerId, assignment]));
    const assignments = memberIds.map((workerId) => {
      const assignment = assignmentByWorkerId.get(workerId);
      if (!assignment) throw new Error('Candidate Team Assignment could not be read');
      return toSelectionAssignment(assignment);
    });

    await transaction
      .update(quest)
      .set({ questStatus: 'QUEST_ASSIGNED', updatedAt: now })
      .where(and(eq(quest.id, questId), eq(quest.questStatus, 'QUEST_OPEN')));

    const writer = getQuestWorkChatMembershipWriter();
    if (!writer) throw new WorkChatTransitionError(new Error('Work Chat membership writer is not configured'));
    try {
      await writer.applyQuestTransition(
        transaction,
        selectionTransitionFor(questId, hirerId, teamId, now, assignments),
      );
    } catch (cause) {
      throw new WorkChatTransitionError(cause);
    }

    const result = { assignments, questState: 'QUEST_ASSIGNED' as const };
    await completeSelectionCommand(transaction, idempotency.record.id, teamId, result, now);
    return result;
  });
};
