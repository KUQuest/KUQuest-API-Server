import { db } from '@/database/client';
import {
  quest,
  questAssignment,
  questDirectJoinCommand,
} from '@/database/schema/quest.schema';

import { and, eq, sql } from 'drizzle-orm';

import {
  assignmentStatus,
  questMode,
  questParticipation,
  questStatus,
  type QuestStatus,
} from './quest.contract';
import type {
  QuestId,
  WorkChatMembershipWriter,
  QuestWorkChatMembershipTransition,
} from './quest-work-chat.contract';
import {
  configureQuestWorkChatMembershipWriter,
  getQuestWorkChatMembershipWriter,
  requireQuestWorkChatMembershipWriter,
  WorkChatTransitionError,
} from './quest-work-chat.port';
import type { QuestTransaction } from './quest-work-chat.port';

type QuestWorkChatWriter = WorkChatMembershipWriter<QuestTransaction>;

export type DirectJoinOptions = {
  commandId: string;
  now?: Date;
  workChatWriter?: QuestWorkChatWriter;
};

type AssignmentRow = {
  id: string;
  questId: string;
  workerId: string;
  assignmentStatus: string;
  startedAt: Date | null;
  createdAt: Date;
  questStatus: QuestStatus;
};

type DirectJoinOutcomeCode =
  | 'not-found'
  | 'not-open'
  | 'not-direct-join'
  | 'hirer-not-allowed'
  | 'already-assigned'
  | 'full'
  | 'idempotency-key-reused'
  | 'idempotency-key-required'
  | 'idempotency-unavailable';

export type DirectJoinOutcome =
  | AssignmentRow
  | { outcome: DirectJoinOutcomeCode };

const assignmentFields = {
  id: questAssignment.id,
  questId: questAssignment.questId,
  workerId: questAssignment.workerId,
  assignmentStatus: questAssignment.assignmentStatus,
  startedAt: questAssignment.startedAt,
  createdAt: questAssignment.createdAt,
};

const commandFields = {
  id: questDirectJoinCommand.id,
  commandId: questDirectJoinCommand.commandId,
  workerId: questDirectJoinCommand.workerId,
  questId: questDirectJoinCommand.questId,
  requestHash: questDirectJoinCommand.requestHash,
  assignmentId: questDirectJoinCommand.assignmentId,
  resultAssignmentStatus: questDirectJoinCommand.resultAssignmentStatus,
  resultStartedAt: questDirectJoinCommand.resultStartedAt,
  resultCreatedAt: questDirectJoinCommand.resultCreatedAt,
  resultQuestStatus: questDirectJoinCommand.resultQuestStatus,
  processingStatus: questDirectJoinCommand.processingStatus,
};

const hashRequest = async (questId: string, workerId: string) => {
  const payload = JSON.stringify({ questId, workerId });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

type DirectJoinCommand = {
  commandId: string;
  workerId: string;
  questId: string;
  requestHash: string;
  assignmentId: string | null;
  resultAssignmentStatus: string | null;
  resultStartedAt: Date | null;
  resultCreatedAt: Date | null;
  resultQuestStatus: QuestStatus | null;
  processingStatus: string;
};

type CommandAcquireResult =
  | { outcome: DirectJoinOutcomeCode }
  | { replay: AssignmentRow }
  | { created: true };

const replayOrConflict = async (
  command: DirectJoinCommand,
  workerId: string,
  questId: string,
  requestHash: string,
): Promise<Exclude<CommandAcquireResult, { created: true }>> => {
  if (command.workerId !== workerId || command.questId !== questId || command.requestHash !== requestHash) {
    return { outcome: 'idempotency-key-reused' as const };
  }
  if (
    command.processingStatus !== 'COMPLETED' ||
    !command.assignmentId ||
    !command.resultAssignmentStatus ||
    !command.resultCreatedAt ||
    !command.resultQuestStatus
  ) {
    return { outcome: 'idempotency-unavailable' as const };
  }
  return {
    replay: {
      id: command.assignmentId,
      questId: command.questId,
      workerId: command.workerId,
      assignmentStatus: command.resultAssignmentStatus,
      startedAt: command.resultStartedAt,
      createdAt: command.resultCreatedAt,
      questStatus: command.resultQuestStatus,
    },
  };
};

const acquireDirectJoinCommand = async (
  transaction: QuestTransaction,
  commandId: string,
  workerId: string,
  questId: string,
  requestHash: string,
  now: Date,
): Promise<CommandAcquireResult> => {
  const [existing] = await transaction
    .select(commandFields)
    .from(questDirectJoinCommand)
    .where(eq(questDirectJoinCommand.commandId, commandId))
    .limit(1)
    .for('update');
  if (existing) return replayOrConflict(existing, workerId, questId, requestHash);

  const [created] = await transaction
    .insert(questDirectJoinCommand)
    .values({ commandId, workerId, questId, requestHash, createdAt: now })
    .onConflictDoNothing({ target: questDirectJoinCommand.commandId })
    .returning(commandFields);
  if (created) return { created: true as const };

  const [concurrent] = await transaction
    .select(commandFields)
    .from(questDirectJoinCommand)
    .where(eq(questDirectJoinCommand.commandId, commandId))
    .limit(1)
    .for('update');
  return concurrent
    ? replayOrConflict(concurrent, workerId, questId, requestHash)
    : { outcome: 'idempotency-unavailable' as const };
};

const lockQuest = async (transaction: QuestTransaction, questId: string) => {
  const [current] = await transaction
    .select({
      id: quest.id,
      hirerId: quest.hirerId,
      mode: quest.mode,
      participation: quest.participation,
      questStatus: quest.questStatus,
      headcount: quest.headcount,
    })
    .from(quest)
    .where(eq(quest.id, questId))
    .limit(1)
    .for('update');

  return current;
};

const transitionFor = (
  questId: QuestId,
  workerId: string,
  assignmentId: string,
  hirerId: string,
  now: Date,
  commandId: string,
): QuestWorkChatMembershipTransition => ({
  producer: 'QUEST_DIRECT_JOIN',
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

/**
 * Accept one Worker into an open NO_CANDIDATE Quest.
 *
 * The Quest row is locked before the active roster is counted. This serializes
 * direct group joins and makes the headcount check safe under concurrency.
 */
export const joinNoCandidateQuest = async (
  workerId: string,
  questId: string,
  options: DirectJoinOptions,
): Promise<DirectJoinOutcome> => {
  const now = options.now ?? new Date();
  const commandId = options.commandId.trim();
  if (!commandId) return { outcome: 'idempotency-key-required' };
  const writer = options.workChatWriter ?? requireQuestWorkChatMembershipWriter();
  const requestHash = await hashRequest(questId, workerId);

  return db.transaction(async (transaction) => {
    const current = await lockQuest(transaction, questId);
    if (!current) return { outcome: 'not-found' };

    const command = await acquireDirectJoinCommand(
      transaction,
      commandId,
      workerId,
      questId,
      requestHash,
      now,
    );
    if ('outcome' in command) return command;
    if ('replay' in command) return command.replay;

    const discardCommand = async (outcome: DirectJoinOutcomeCode) => {
      await transaction
        .delete(questDirectJoinCommand)
        .where(eq(questDirectJoinCommand.commandId, commandId));
      return { outcome };
    };
    if (current.mode !== questMode.noCandidate) return discardCommand('not-direct-join');
    if (current.hirerId === workerId) return discardCommand('hirer-not-allowed');

    const [existing] = await transaction
      .select({ id: questAssignment.id })
      .from(questAssignment)
      .where(and(eq(questAssignment.questId, questId), eq(questAssignment.workerId, workerId)))
      .limit(1);
    if (existing) return discardCommand('already-assigned');
    if (current.questStatus !== questStatus.open) return discardCommand('not-open');

    const [activeCount] = await transaction
      .select({ count: sql<number>`count(*)` })
      .from(questAssignment)
      .where(
        and(
          eq(questAssignment.questId, questId),
          eq(questAssignment.assignmentStatus, assignmentStatus.active),
        ),
      );
    const joinedCount = Number(activeCount?.count ?? 0);
    if (joinedCount >= current.headcount) return discardCommand('full');

    const [assignment] = await transaction
      .insert(questAssignment)
      .values({
        questId,
        workerId,
        assignmentStatus: assignmentStatus.active,
        createdAt: now,
      })
      .returning(assignmentFields);

    const nextStatus = current.participation === questParticipation.solo || joinedCount + 1 === current.headcount
      ? questStatus.assigned
      : questStatus.open;
    await transaction
      .update(quest)
      .set({ questStatus: nextStatus, updatedAt: now })
      .where(and(eq(quest.id, questId), eq(quest.questStatus, questStatus.open)));

    const transition = transitionFor(
      questId,
      workerId,
      assignment.id,
      current.hirerId,
      now,
      commandId,
    );
    try {
      await writer.applyQuestTransition(transaction, transition);
    } catch (cause) {
      throw new WorkChatTransitionError(cause);
    }

    await transaction
      .update(questDirectJoinCommand)
      .set({
        assignmentId: assignment.id,
        resultAssignmentStatus: assignment.assignmentStatus,
        resultStartedAt: assignment.startedAt,
        resultCreatedAt: assignment.createdAt,
        resultQuestStatus: nextStatus,
        processingStatus: 'COMPLETED',
        completedAt: now,
      })
      .where(eq(questDirectJoinCommand.commandId, commandId));

    return { ...assignment, questStatus: nextStatus };
  });
};

export {
  configureQuestWorkChatMembershipWriter,
  getQuestWorkChatMembershipWriter,
  requireQuestWorkChatMembershipWriter,
  WorkChatTransitionError,
};
export type { QuestTransaction } from './quest-work-chat.port';
