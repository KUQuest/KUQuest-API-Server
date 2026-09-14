import { db } from '@/database/client';
import { quest, questApiVersion, questAssignment } from '@/database/schema/quest.schema';

import { and, eq } from 'drizzle-orm';

import {
  getQuestWorkChatMembershipWriter,
  WorkChatTransitionError,
  type QuestTransaction,
} from './quest-work-chat.port';
import {
  runQuestCommand,
  type QuestCommandOutcomeCode,
  type QuestCommandWork,
} from './quest-command.service';
import type { QuestWorkChatMembershipTransition } from './quest-work-chat.contract';
import {
  questV2AssignmentStates,
  questV2Mode,
  questV2Participation,
  type QuestV2AssignmentState,
} from './quest-v2.contract';

export type SelectionAssignmentRow = {
  id: string;
  questId: string;
  workerId: string;
  state: QuestV2AssignmentState;
  questState: 'QUEST_ASSIGNED';
  startedAt: Date | null;
  createdAt: Date;
};

export type SelectionSuccess = {
  assignments: SelectionAssignmentRow[];
  questState: 'QUEST_ASSIGNED';
};

/** The Quest row the kernel locks and gates on, exposed to the caller's hooks. */
export type SelectionQuest = {
  hirerId: string;
  v2Mode: string | null;
  v2Participation: string | null;
  questState: string;
  startTime: Date;
};

/** Per-caller answers for the three gates whose codes have drifted between SINGLE and GROUP. */
export type SelectionGateCodes<C extends string> = {
  notHirer: C;
  notMode: C;
  notParticipation: C;
};

/** The GROUP-shaped half: lock the selected resource, validate it, and name the Workers. */
export type SelectionResource<C extends string> =
  | { kind: 'rejected'; rejection: C }
  | {
      kind: 'selected';
      /** Workers to assign, in the order their Assignment rows must be returned. */
      workerIds: string[];
      /**
       * Resource pointer recorded on the Quest Command row. When passed as a function,
       * it is resolved against the created Assignments before Work Chat is updated.
       */
      resourceId: string | ((assignments: SelectionAssignmentRow[]) => string);
      /** Flips the candidate records. Runs after the duplicate check, before the Assignment insert. */
      flipCandidateRecords: (transaction: QuestTransaction) => Promise<void>;
    };

export type RunSelectionInput<C extends string> = {
  hirerId: string;
  questId: string;
  rawCommandId: string;
  now: Date;
  operationScope: string;
  requestHash: string;
  /** Required `v2Participation` for this path: 'single' or 'group'. */
  participation: 'single' | 'group';
  gates: SelectionGateCodes<C>;
  /** Resource type recorded on the Quest Command row. */
  resourceType: string;
  /** Locks and validates the selected resource. Runs after the Quest gates pass. */
  selectResource: (
    transaction: QuestTransaction,
    current: SelectionQuest
  ) => Promise<SelectionResource<C>>;
  /** Builds the Work Conversation entry for the created Assignments. */
  transitionFor: (input: {
    questId: string;
    hirerId: string;
    now: Date;
    resourceId: string;
    assignments: SelectionAssignmentRow[];
  }) => QuestWorkChatMembershipTransition;
};

const assignmentFields = {
  id: questAssignment.id,
  questId: questAssignment.questId,
  workerId: questAssignment.workerId,
  state: questAssignment.assignmentStatus,
  startedAt: questAssignment.startedAt,
  createdAt: questAssignment.createdAt,
};

const toSelectionAssignment = (row: {
  id: string;
  questId: string;
  workerId: string;
  state: string;
  startedAt: Date | null;
  createdAt: Date;
}): SelectionAssignmentRow => {
  if (!(questV2AssignmentStates as readonly string[]).includes(row.state)) {
    throw new Error('Assignment has an invalid state for Quest API V2');
  }
  return {
    ...row,
    state: row.state as QuestV2AssignmentState,
    questState: 'QUEST_ASSIGNED',
  };
};

const selectionSnapshotFor = (result: SelectionSuccess) => ({
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

const selectionFromSnapshot = (value: unknown): SelectionSuccess | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const snapshot = value as {
    questState?: unknown;
    assignments?: unknown;
  };
  if (snapshot.questState !== 'QUEST_ASSIGNED' || !Array.isArray(snapshot.assignments)) {
    return undefined;
  }
  if (snapshot.assignments.length === 0) return undefined;
  const assignments: SelectionAssignmentRow[] = [];
  for (const snapshotValue of snapshot.assignments) {
    if (!snapshotValue || typeof snapshotValue !== 'object' || Array.isArray(snapshotValue))
      return undefined;
    const assignment = snapshotValue as Record<string, unknown>;
    if (
      typeof assignment.id !== 'string' ||
      typeof assignment.questId !== 'string' ||
      typeof assignment.workerId !== 'string' ||
      typeof assignment.state !== 'string' ||
      assignment.questState !== 'QUEST_ASSIGNED' ||
      typeof assignment.createdAt !== 'string' ||
      (assignment.startedAt !== null && typeof assignment.startedAt !== 'string') ||
      !(questV2AssignmentStates as readonly string[]).includes(assignment.state)
    )
      return undefined;
    const createdAt = new Date(assignment.createdAt);
    const startedAt = assignment.startedAt === null ? null : new Date(assignment.startedAt);
    if (Number.isNaN(createdAt.getTime()) || (startedAt && Number.isNaN(startedAt.getTime()))) {
      return undefined;
    }
    assignments.push({
      id: assignment.id,
      questId: assignment.questId,
      workerId: assignment.workerId,
      state: assignment.state as QuestV2AssignmentState,
      questState: 'QUEST_ASSIGNED',
      startedAt,
      createdAt,
    });
  }
  return { assignments, questState: 'QUEST_ASSIGNED' };
};

/**
 * Locks the v2 Quest row for the caller's command. Selects the union of the
 * columns every v2 candidate flow gates on, so one lock serves both the
 * SINGLE and GROUP paths.
 */
export const lockQuest = async (transaction: QuestTransaction, questId: string) => {
  const [current] = await transaction
    .select({
      hirerId: quest.hirerId,
      v2Mode: quest.v2Mode,
      v2Participation: quest.v2Participation,
      questState: quest.questStatus,
      hiddenAt: quest.hiddenAt,
      headcount: quest.headcount,
      startTime: quest.startTime,
    })
    .from(quest)
    .where(and(eq(quest.id, questId), eq(quest.apiVersion, questApiVersion.v2)))
    .limit(1)
    .for('update');
  return current;
};

/**
 * Runs one Candidate selection. Opens the transaction, locks the Quest, records the
 * Quest Command, runs the shared gates, delegates the resource work, creates the
 * Assignments, moves the Quest to QUEST_ASSIGNED and writes the Work Conversation entry.
 *
 * The Quest row is locked before the module records the command. The command row's
 * quest foreign key takes FOR KEY SHARE on the Quest row, so taking the caller's
 * FOR UPDATE after the module's insert deadlocks two concurrent commands that
 * target the same Quest.
 */
export const runQuestV2Selection = async <C extends string>(
  input: RunSelectionInput<C>
): Promise<SelectionSuccess | { outcome: C | 'not-found' | QuestCommandOutcomeCode }> =>
  db.transaction(async (transaction) => {
    const current = await lockQuest(transaction, input.questId);
    if (!current) return { outcome: 'not-found' };

    const command = await runQuestCommand({
      transaction,
      identity: {
        principalUserId: input.hirerId,
        operationScope: input.operationScope,
        key: input.rawCommandId,
        requestHash: input.requestHash,
        questId: input.questId,
      },
      now: input.now,
      work: async (): Promise<QuestCommandWork<SelectionSuccess, C>> => {
        if (current.hirerId !== input.hirerId) {
          return { kind: 'rejected', rejection: input.gates.notHirer };
        }
        if (current.v2Mode !== questV2Mode.candidate) {
          return { kind: 'rejected', rejection: input.gates.notMode };
        }
        if (current.v2Participation !== questV2Participation[input.participation]) {
          return { kind: 'rejected', rejection: input.gates.notParticipation };
        }
        if (current.questState !== 'QUEST_OPEN') {
          return { kind: 'rejected', rejection: 'not-open' as C };
        }
        if (current.startTime.getTime() <= input.now.getTime()) {
          return { kind: 'rejected', rejection: 'not-open' as C };
        }

        const resource = await input.selectResource(transaction, current);
        if (resource.kind === 'rejected') {
          return { kind: 'rejected', rejection: resource.rejection };
        }

        const existingAssignments = await transaction
          .select(assignmentFields)
          .from(questAssignment)
          .where(eq(questAssignment.questId, input.questId))
          .for('update');
        if (
          existingAssignments.some((assignment) => resource.workerIds.includes(assignment.workerId))
        ) {
          return { kind: 'rejected', rejection: 'already-assigned' as C };
        }

        await resource.flipCandidateRecords(transaction);

        const createdAssignments = await transaction
          .insert(questAssignment)
          .values(
            resource.workerIds.map((workerId) => ({
              questId: input.questId,
              workerId,
              assignmentStatus: 'ASSIGNMENT_ACTIVE',
              createdAt: input.now,
            }))
          )
          .returning(assignmentFields);
        if (createdAssignments.length !== resource.workerIds.length) {
          throw new Error('Assignment insert returned invalid rows');
        }
        const assignmentByWorkerId = new Map(
          createdAssignments.map((assignment) => [assignment.workerId, assignment])
        );
        const assignments = resource.workerIds.map((workerId) => {
          const assignment = assignmentByWorkerId.get(workerId);
          if (!assignment) throw new Error('Assignment could not be read');
          return toSelectionAssignment(assignment);
        });

        const resourceId =
          typeof resource.resourceId === 'function'
            ? resource.resourceId(assignments)
            : resource.resourceId;

        await transaction
          .update(quest)
          .set({ questStatus: 'QUEST_ASSIGNED', updatedAt: input.now })
          .where(and(eq(quest.id, input.questId), eq(quest.questStatus, 'QUEST_OPEN')));

        const writer = getQuestWorkChatMembershipWriter();
        if (!writer) {
          throw new WorkChatTransitionError(
            new Error('Work Chat membership writer is not configured')
          );
        }
        try {
          await writer.applyQuestTransition(
            transaction,
            input.transitionFor({
              questId: input.questId,
              hirerId: input.hirerId,
              now: input.now,
              resourceId,
              assignments,
            })
          );
        } catch (cause) {
          throw new WorkChatTransitionError(cause);
        }

        return {
          kind: 'success',
          result: { assignments, questState: 'QUEST_ASSIGNED' },
          resourceType: input.resourceType,
          resourceId,
        };
      },
      toSnapshot: selectionSnapshotFor,
      fromSnapshot: selectionFromSnapshot,
    });

    if ('outcome' in command) return { outcome: command.outcome };
    if (command.kind === 'success') return command.result;
    return { outcome: command.rejection };
  });
