import { db } from '@/database/client';
import { quest, questApiVersion, questAssignment } from '@/database/schema/quest.schema';

import { and, asc, eq, sql } from 'drizzle-orm';

import {
  type QuestTransaction,
  requireQuestWorkChatMembershipWriter,
  WorkChatTransitionError,
} from './quest-work-chat.port';
import {
  runQuestCommand,
  sha256Json,
  type QuestCommandOutcomeCode,
  type QuestCommandWork,
} from './quest-command.service';
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

type QuestV2AssignmentOutcomeCode = QuestV2AssignmentBusinessOutcomeCode | QuestCommandOutcomeCode;

export type QuestV2AssignmentOutcome =
  QuestV2AssignmentRow | { outcome: QuestV2AssignmentOutcomeCode };

export type QuestV2AssignmentReadOutcome =
  QuestV2AssignmentRow[] | { outcome: 'not-authorized' | 'not-found' };

const assignmentFields = {
  id: questAssignment.id,
  questId: questAssignment.questId,
  workerId: questAssignment.workerId,
  state: questAssignment.assignmentStatus,
  startedAt: questAssignment.startedAt,
  createdAt: questAssignment.createdAt,
};

const requestHashFor = (userId: string, questId: string): Promise<string> =>
  sha256Json({
    authenticatedMemberId: userId,
    operation: questV2AssignmentJoinOperationScope,
    path: '/api/v2/quests/:questId/join',
    questId,
    body: {},
  });

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
  questState: string
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
  )
    return undefined;
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
  commandId: string
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
  questState: string
): Promise<QuestV2AssignmentRow[]> => {
  const rows = await transaction
    .select(assignmentFields)
    .from(questAssignment)
    .where(
      and(
        eq(questAssignment.questId, questId),
        eq(questAssignment.assignmentStatus, 'ASSIGNMENT_ACTIVE')
      )
    )
    .orderBy(asc(questAssignment.createdAt), asc(questAssignment.id));
  return rows.map((row) => toQuestV2AssignmentRow(row, questState));
};

const joinQuestV2InTransaction = async (
  transaction: QuestTransaction,
  userId: string,
  questId: string,
  key: string,
  now: Date,
  writer: WorkChatMembershipWriter<QuestTransaction>
): Promise<QuestV2AssignmentOutcome> => {
  // The Quest row is locked before the module records the command. The command row's
  // quest foreign key takes FOR KEY SHARE on the Quest row, so taking the caller's
  // FOR UPDATE after the module's insert deadlocks two concurrent Joins that target
  // the same Quest.
  const current = await lockQuest(transaction, questId);
  if (!current) return { outcome: 'not-found' };

  const command = await runQuestCommand({
    transaction,
    identity: {
      principalUserId: userId,
      operationScope: questV2AssignmentJoinOperationScope,
      key,
      requestHash: await requestHashFor(userId, questId),
      questId,
    },
    now,
    work: async (): Promise<
      QuestCommandWork<QuestV2AssignmentRow, QuestV2AssignmentBusinessOutcomeCode>
    > => {
      if (current.v2Mode !== questV2Mode.firstComeFirstServed) {
        return { kind: 'rejected', rejection: 'not-first-come-first-served' };
      }
      const isSingleQuest = current.v2Participation === questV2Participation.single;
      const isGroupQuest = current.v2Participation === questV2Participation.group;
      if (!isSingleQuest && !isGroupQuest) {
        return { kind: 'rejected', rejection: 'not-supported-participation' };
      }
      if (current.hirerId === userId) return { kind: 'rejected', rejection: 'hirer-not-allowed' };

      const [existing] = await transaction
        .select({ id: questAssignment.id })
        .from(questAssignment)
        .where(and(eq(questAssignment.questId, questId), eq(questAssignment.workerId, userId)))
        .limit(1);
      if (existing) return { kind: 'rejected', rejection: 'already-assigned' };
      // A hidden Quest is out of reach for Members, so it refuses a join the same way a
      // Quest that is not open does.
      if (current.questState !== 'QUEST_OPEN' || current.hiddenAt !== null) {
        return { kind: 'rejected', rejection: 'not-open' };
      }
      if (current.startTime.getTime() <= now.getTime()) {
        return { kind: 'rejected', rejection: isGroupQuest ? 'roster-frozen' : 'not-open' };
      }

      const [activeCount] = await transaction
        .select({ count: sql<number>`count(*)` })
        .from(questAssignment)
        .where(
          and(
            eq(questAssignment.questId, questId),
            eq(questAssignment.assignmentStatus, 'ASSIGNMENT_ACTIVE')
          )
        );
      const joinedCount = Number(activeCount?.count ?? 0);
      if (joinedCount >= current.headcount) return { kind: 'rejected', rejection: 'full' };

      const [createdAssignment] = await transaction
        .insert(questAssignment)
        .values({
          questId,
          workerId: userId,
          assignmentStatus: 'ASSIGNMENT_ACTIVE',
          createdAt: now,
        })
        .returning(assignmentFields);
      if (!createdAssignment) throw new Error('Assignment insert returned no row');

      const nextQuestState =
        isSingleQuest || joinedCount + 1 === current.headcount ? 'QUEST_ASSIGNED' : 'QUEST_OPEN';
      await transaction
        .update(quest)
        .set({ questStatus: nextQuestState, updatedAt: now })
        .where(and(eq(quest.id, questId), eq(quest.questStatus, 'QUEST_OPEN')));

      const assignment = toQuestV2AssignmentRow(createdAssignment, nextQuestState);
      const workChatCommandId = `quest-assignment-v2:${assignment.id}`;
      try {
        await writer.applyQuestTransition(
          transaction,
          transitionFor(questId, userId, assignment.id, current.hirerId, now, workChatCommandId)
        );
      } catch (cause) {
        throw new WorkChatTransitionError(cause);
      }

      return {
        kind: 'success',
        result: assignment,
        resourceType: 'quest-assignment-v2',
        resourceId: assignment.id,
      };
    },
    toSnapshot: snapshotFor,
    fromSnapshot: assignmentFromSnapshot,
  });

  if ('outcome' in command) return { outcome: command.outcome };
  if (command.kind === 'success') return command.result;
  return { outcome: command.rejection };
};

export const joinQuestV2 = async (
  workerId: string,
  questId: string,
  rawCommandId: string,
  now: Date
): Promise<QuestV2AssignmentOutcome> => {
  const writer = requireQuestWorkChatMembershipWriter();
  return db.transaction((transaction) =>
    joinQuestV2InTransaction(transaction, workerId, questId, rawCommandId, now, writer)
  );
};

export const listQuestV2Assignments = async (
  memberId: string,
  questId: string
): Promise<QuestV2AssignmentReadOutcome> => {
  const [current] = await db
    .select({ hirerId: quest.hirerId, questState: quest.questStatus })
    .from(quest)
    .where(and(eq(quest.id, questId), eq(quest.apiVersion, questApiVersion.v2)))
    .limit(1);
  if (!current) return { outcome: 'not-found' };

  if (current.hirerId === memberId) {
    return db.transaction((transaction) =>
      listAssignments(transaction, questId, current.questState)
    );
  }

  const assignments = await db
    .select(assignmentFields)
    .from(questAssignment)
    .where(
      and(
        eq(questAssignment.questId, questId),
        eq(questAssignment.workerId, memberId),
        eq(questAssignment.assignmentStatus, 'ASSIGNMENT_ACTIVE')
      )
    )
    .orderBy(asc(questAssignment.createdAt), asc(questAssignment.id));
  if (assignments.length === 0) return { outcome: 'not-authorized' };
  return assignments.map((assignment) => toQuestV2AssignmentRow(assignment, current.questState));
};

export const listMyQuestV2Assignments = async (
  workerId: string
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
        eq(quest.apiVersion, questApiVersion.v2)
      )
    )
    .orderBy(asc(questAssignment.createdAt), asc(questAssignment.id));
  return rows.map((row) => toQuestV2AssignmentRow(row, row.questState));
};
