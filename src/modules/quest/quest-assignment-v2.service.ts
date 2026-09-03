import { db } from '@/database/client';
import { quest, questApiVersion, questAssignment } from '@/database/schema/quest.schema';
import { walletIdempotencyKey } from '@/database/schema/wallet.schema';

import { and, asc, eq, sql } from 'drizzle-orm';

import {
  type QuestTransaction,
  requireQuestWorkChatMembershipWriter,
  WorkChatTransitionError,
} from './quest-work-chat.port';
import {
  questV2AssignmentStates,
  questV2Mode,
  questV2Participation,
  questV2States,
  type QuestV2AssignmentState,
  type QuestV2State,
} from './quest-v2.contract';
import type {
  QuestWorkChatMembershipTransition,
  WorkChatMembershipWriter,
} from './quest-work-chat.contract';

export const questV2AssignmentJoinOperationScope = 'quest.v2.assignment.join';

type QuestV2AssignmentRow = {
  id: string;
  questId: string;
  workerId: string;
  state: QuestV2AssignmentState;
  startedAt: Date | null;
  createdAt: Date;
  questState: QuestV2State;
};

type QuestV2AssignmentBusinessOutcomeCode =
  | 'already-assigned'
  | 'full'
  | 'hirer-not-allowed'
  | 'not-open'
  | 'not-supported-participation'
  | 'not-found'
  | 'roster-frozen'
  | 'not-first-come-first-served';

type QuestV2AssignmentIdempotencyOutcomeCode =
  | 'idempotency-in-progress'
  | 'idempotency-key-reused'
  | 'idempotency-unavailable'
  | 'invalid-idempotency-key';

type QuestV2AssignmentOutcomeCode =
  | QuestV2AssignmentBusinessOutcomeCode
  | QuestV2AssignmentIdempotencyOutcomeCode;

export type QuestV2AssignmentOutcome =
  | QuestV2AssignmentRow
  | { outcome: QuestV2AssignmentOutcomeCode };

export type QuestV2AssignmentReadOutcome =
  | QuestV2AssignmentRow[]
  | { outcome: 'not-authorized' | 'not-found' };

type IdempotencyRecord = {
  id: string;
  requestHash: string;
  resourceId: string | null;
  resultData: unknown;
  processingStatus: string;
};

type CommandAcquireResult =
  | { created: true; record: IdempotencyRecord }
  | { created: false; record: IdempotencyRecord }
  | { outcome: QuestV2AssignmentIdempotencyOutcomeCode };

const assignmentFields = {
  id: questAssignment.id,
  questId: questAssignment.questId,
  workerId: questAssignment.workerId,
  state: questAssignment.assignmentStatus,
  startedAt: questAssignment.startedAt,
  createdAt: questAssignment.createdAt,
};

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

const requestHashFor = (userId: string, questId: string): Promise<string> =>
  sha256Json({
    authenticatedMemberId: userId,
    operation: questV2AssignmentJoinOperationScope,
    path: '/api/v2/quests/:questId/join',
    questId,
    body: {},
  });

const idempotencyExpiry = () => new Date(Date.now() + 24 * 60 * 60 * 1000);

const isQuestV2State = (value: string): value is QuestV2State =>
  (questV2States as readonly string[]).includes(value);

const toQuestV2AssignmentRow = (
  assignment: {
    id: string;
    questId: string;
    workerId: string;
    state: string;
    startedAt: Date | null;
    createdAt: Date;
  },
  questState: string,
): QuestV2AssignmentRow => {
  if (!(questV2AssignmentStates as readonly string[]).includes(assignment.state)) {
    throw new Error('Assignment has an invalid state for Quest API V2');
  }
  if (!isQuestV2State(questState)) {
    throw new Error('Quest has an invalid state for Quest API V2');
  }
  return {
    ...assignment,
    state: assignment.state as QuestV2AssignmentState,
    questState,
  };
};

const snapshotFor = (assignment: QuestV2AssignmentRow): Record<string, unknown> => ({
  id: assignment.id,
  questId: assignment.questId,
  workerId: assignment.workerId,
  state: assignment.state,
  questState: assignment.questState,
  startedAt: assignment.startedAt?.toISOString() ?? null,
  createdAt: assignment.createdAt.toISOString(),
});

const assignmentFromSnapshot = (value: unknown): QuestV2AssignmentRow | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const snapshot = value as Partial<Record<keyof QuestV2AssignmentRow, unknown>>;
  if (
    typeof snapshot.id !== 'string' ||
    typeof snapshot.questId !== 'string' ||
    typeof snapshot.workerId !== 'string' ||
    typeof snapshot.state !== 'string' ||
    typeof snapshot.questState !== 'string' ||
    typeof snapshot.createdAt !== 'string' ||
    (snapshot.startedAt !== null && typeof snapshot.startedAt !== 'string')
  ) return undefined;
  if (!(questV2AssignmentStates as readonly string[]).includes(snapshot.state)) return undefined;
  if (!isQuestV2State(snapshot.questState)) return undefined;
  const createdAt = new Date(snapshot.createdAt);
  const startedAt = snapshot.startedAt === null ? null : new Date(snapshot.startedAt);
  if (Number.isNaN(createdAt.getTime()) || (startedAt && Number.isNaN(startedAt.getTime()))) {
    return undefined;
  }
  return {
    id: snapshot.id,
    questId: snapshot.questId,
    workerId: snapshot.workerId,
    state: snapshot.state as QuestV2AssignmentState,
    questState: snapshot.questState,
    startedAt,
    createdAt,
  };
};

const idempotencyFields = {
  id: walletIdempotencyKey.id,
  requestHash: walletIdempotencyKey.requestHash,
  resourceId: walletIdempotencyKey.resourceId,
  resultData: walletIdempotencyKey.resultData,
  processingStatus: walletIdempotencyKey.processingStatus,
};

const acquireIdempotency = async (
  transaction: QuestTransaction,
  userId: string,
  key: string,
  requestHash: string,
): Promise<CommandAcquireResult> => {
  const [created] = await transaction
    .insert(walletIdempotencyKey)
    .values({
      principalUserId: userId,
      operationScope: questV2AssignmentJoinOperationScope,
      key,
      requestHash,
      expiresAt: idempotencyExpiry(),
    })
    .onConflictDoNothing()
    .returning(idempotencyFields);
  if (created) return { created: true, record: created };

  const [existing] = await transaction
    .select(idempotencyFields)
    .from(walletIdempotencyKey)
    .where(
      and(
        eq(walletIdempotencyKey.principalUserId, userId),
        eq(walletIdempotencyKey.operationScope, questV2AssignmentJoinOperationScope),
        eq(walletIdempotencyKey.key, key),
      ),
    )
    .limit(1)
    .for('update');
  if (!existing) return { outcome: 'idempotency-unavailable' };
  if (existing.requestHash !== requestHash) return { outcome: 'idempotency-key-reused' };
  if (existing.resourceId) return { created: false, record: existing };
  if (existing.processingStatus !== 'PROCESSING') {
    return { outcome: 'idempotency-unavailable' };
  }
  return { outcome: 'idempotency-in-progress' };
};

const lockQuest = async (transaction: QuestTransaction, questId: string) => {
  const [current] = await transaction
    .select({
      hirerId: quest.hirerId,
      v2Mode: quest.v2Mode,
      v2Participation: quest.v2Participation,
      questState: quest.questStatus,
      headcount: quest.headcount,
      hiddenAt: quest.hiddenAt,
      startTime: quest.startTime,
    })
    .from(quest)
    .where(and(eq(quest.id, questId), eq(quest.apiVersion, questApiVersion.v2)))
    .limit(1)
    .for('update');
  return current;
};

const transitionFor = (
  questId: string,
  workerId: string,
  assignmentId: string,
  hirerId: string,
  now: Date,
  commandId: string,
): QuestWorkChatMembershipTransition => ({
  producer: 'QUEST_ASSIGNMENT_V2',
  type: 'workersAccepted',
  commandId,
  eventId: assignmentId,
  questId,
  actorId: workerId,
  hirerId,
  occurredAt: now.toISOString(),
  workers: [
    {
      workerId,
      assignmentId,
      joinedAt: now.toISOString(),
    },
  ],
});

const listAssignments = async (
  transaction: QuestTransaction,
  questId: string,
  questState: string,
): Promise<QuestV2AssignmentRow[]> => {
  const rows = await transaction
    .select(assignmentFields)
    .from(questAssignment)
    .where(
      and(
        eq(questAssignment.questId, questId),
        eq(questAssignment.assignmentStatus, 'ASSIGNMENT_ACTIVE'),
      ),
    )
    .orderBy(asc(questAssignment.createdAt), asc(questAssignment.id));
  return rows.map((row) => toQuestV2AssignmentRow(row, questState));
};

const joinQuestV2InTransaction = async (
  transaction: QuestTransaction,
  userId: string,
  questId: string,
  commandId: string,
  requestHash: string,
  now: Date,
  writer: WorkChatMembershipWriter<QuestTransaction>,
): Promise<QuestV2AssignmentOutcome> => {
  const current = await lockQuest(transaction, questId);
  if (!current) return { outcome: 'not-found' };

  const idempotency = await acquireIdempotency(transaction, userId, commandId, requestHash);
  if ('outcome' in idempotency) return idempotency;

  if (!idempotency.created && idempotency.record.resourceId) {
    const replay = assignmentFromSnapshot(idempotency.record.resultData);
    return replay ? replay : { outcome: 'idempotency-unavailable' };
  }

  const discardIdempotency = async (
    outcome: QuestV2AssignmentBusinessOutcomeCode,
  ) => {
    await transaction
      .delete(walletIdempotencyKey)
      .where(eq(walletIdempotencyKey.id, idempotency.record.id));
    return { outcome };
  };

  if (current.v2Mode !== questV2Mode.firstComeFirstServed) {
    return discardIdempotency('not-first-come-first-served');
  }
  const isSingleQuest = current.v2Participation === questV2Participation.single;
  const isGroupQuest = current.v2Participation === questV2Participation.group;
  if (!isSingleQuest && !isGroupQuest) {
    return discardIdempotency('not-supported-participation');
  }
  if (current.hirerId === userId) return discardIdempotency('hirer-not-allowed');

  const [existing] = await transaction
    .select({ id: questAssignment.id })
    .from(questAssignment)
    .where(and(eq(questAssignment.questId, questId), eq(questAssignment.workerId, userId)))
    .limit(1);
  if (existing) return discardIdempotency('already-assigned');
  // A hidden Quest is out of reach for Members, so it refuses a join the same way a
  // Quest that is not open does.
  if (current.questState !== 'QUEST_OPEN' || current.hiddenAt !== null) {
    return discardIdempotency('not-open');
  }
  if (isGroupQuest && current.startTime.getTime() <= now.getTime()) {
    return discardIdempotency('roster-frozen');
  }

  const [activeCount] = await transaction
    .select({ count: sql<number>`count(*)` })
    .from(questAssignment)
    .where(
      and(
        eq(questAssignment.questId, questId),
        eq(questAssignment.assignmentStatus, 'ASSIGNMENT_ACTIVE'),
      ),
    );
  const joinedCount = Number(activeCount?.count ?? 0);
  if (joinedCount >= current.headcount) return discardIdempotency('full');

  const [createdAssignment] = await transaction
    .insert(questAssignment)
    .values({
      questId,
      workerId: userId,
      assignmentStatus: 'ASSIGNMENT_ACTIVE',
      createdAt: now,
    })
    .returning(assignmentFields);
  if (!createdAssignment) return { outcome: 'idempotency-unavailable' };

  const nextQuestState = isSingleQuest || joinedCount + 1 === current.headcount
    ? 'QUEST_ASSIGNED'
    : 'QUEST_OPEN';
  await transaction
    .update(quest)
    .set({ questStatus: nextQuestState, updatedAt: now })
    .where(and(eq(quest.id, questId), eq(quest.questStatus, 'QUEST_OPEN')));

  const assignment = toQuestV2AssignmentRow(createdAssignment, nextQuestState);
  const workChatCommandId = `quest-assignment-v2:${assignment.id}`;
  try {
    await writer.applyQuestTransition(
      transaction,
      transitionFor(questId, userId, assignment.id, current.hirerId, now, workChatCommandId),
    );
  } catch (cause) {
    throw new WorkChatTransitionError(cause);
  }

  await transaction
    .update(walletIdempotencyKey)
    .set({
      resourceType: 'quest-assignment-v2',
      resourceId: assignment.id,
      resultData: snapshotFor(assignment),
      processingStatus: 'COMPLETED',
      completedAt: now,
    })
    .where(eq(walletIdempotencyKey.id, idempotency.record.id));

  return assignment;
};

export const joinQuestV2 = async (
  workerId: string,
  questId: string,
  rawCommandId: string,
  now = new Date(),
): Promise<QuestV2AssignmentOutcome> => {
  const commandId = rawCommandId.trim();
  if (commandId.length === 0 || commandId.length > 200) {
    return { outcome: 'invalid-idempotency-key' };
  }
  const requestHash = await requestHashFor(workerId, questId);
  const writer = requireQuestWorkChatMembershipWriter();
  return db.transaction((transaction) =>
    joinQuestV2InTransaction(
      transaction,
      workerId,
      questId,
      commandId,
      requestHash,
      now,
      writer,
    ),
  );
};

export const listQuestV2Assignments = async (
  memberId: string,
  questId: string,
): Promise<QuestV2AssignmentReadOutcome> => {
  const [current] = await db
    .select({ hirerId: quest.hirerId, questState: quest.questStatus })
    .from(quest)
    .where(and(eq(quest.id, questId), eq(quest.apiVersion, questApiVersion.v2)))
    .limit(1);
  if (!current) return { outcome: 'not-found' };

  if (current.hirerId === memberId) {
    return db.transaction((transaction) =>
      listAssignments(transaction, questId, current.questState),
    );
  }

  const assignments = await db
    .select(assignmentFields)
    .from(questAssignment)
    .where(
      and(
        eq(questAssignment.questId, questId),
        eq(questAssignment.workerId, memberId),
        eq(questAssignment.assignmentStatus, 'ASSIGNMENT_ACTIVE'),
      ),
    )
    .orderBy(asc(questAssignment.createdAt), asc(questAssignment.id));
  if (assignments.length === 0) return { outcome: 'not-authorized' };
  return assignments.map((assignment) => toQuestV2AssignmentRow(assignment, current.questState));
};

export const listMyQuestV2Assignments = async (
  workerId: string,
): Promise<QuestV2AssignmentRow[]> => {
  const rows = await db
    .select({
      ...assignmentFields,
      questState: quest.questStatus,
    })
    .from(questAssignment)
    .innerJoin(quest, eq(questAssignment.questId, quest.id))
    .where(
      and(
        eq(questAssignment.workerId, workerId),
        eq(questAssignment.assignmentStatus, 'ASSIGNMENT_ACTIVE'),
        eq(quest.apiVersion, questApiVersion.v2),
      ),
    )
    .orderBy(asc(questAssignment.createdAt), asc(questAssignment.id));
  return rows.map((row) => toQuestV2AssignmentRow(row, row.questState));
};
