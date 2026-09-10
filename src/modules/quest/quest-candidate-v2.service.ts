import { db } from '@/database/client';
import {
  quest,
  questApiVersion,
  questCandidateApplicationV2,
  questAssignment,
} from '@/database/schema/quest.schema';

import { and, asc, eq, ne } from 'drizzle-orm';

import {
  getQuestWorkChatMembershipWriter,
  WorkChatTransitionError,
  type QuestTransaction,
} from './quest-work-chat.port';
import {
  runQuestCommand,
  sha256Json,
  type QuestCommandOutcomeCode,
  type QuestCommandWork,
} from './quest-command.service';
import type { AcceptedWorker, QuestWorkChatMembershipTransition } from './quest-work-chat.contract';
import {
  questV2ApplicationStates,
  questV2AssignmentStates,
  questV2Mode,
  questV2Participation,
  type QuestV2ApplicationState,
  type QuestV2AssignmentState,
} from './quest-v2.contract';

export const questV2CandidateApplicationCreateOperationScope =
  'quest.v2.candidate-application.create';
export const questV2CandidateApplicationWithdrawOperationScope =
  'quest.v2.candidate-application.withdraw';
export const questV2CandidateApplicationSelectOperationScope =
  'quest.v2.candidate-application.select';

type QuestV2CandidateApplicationRow = {
  id: string;
  questId: string;
  memberId: string;
  state: QuestV2ApplicationState;
  appliedAt: Date;
};

type CandidateApplicationBusinessOutcomeCode =
  'already-exists' | 'hirer-not-allowed' | 'not-candidate' | 'not-open' | 'not-single';

type CandidateApplicationOutcomeCode =
  CandidateApplicationBusinessOutcomeCode | 'not-found' | QuestCommandOutcomeCode;

export type QuestV2CandidateApplicationOutcome =
  QuestV2CandidateApplicationRow | { outcome: CandidateApplicationOutcomeCode };

export type QuestV2CandidateApplicationReadOutcome =
  QuestV2CandidateApplicationRow[] | { outcome: 'not-authorized' | 'not-found' };

export type QuestV2CandidateApplicationDetailOutcome =
  | QuestV2CandidateApplicationRow
  | { outcome: 'application-not-found' | 'not-authorized' | 'not-found' };

const applicationFields = {
  id: questCandidateApplicationV2.id,
  questId: questCandidateApplicationV2.questId,
  memberId: questCandidateApplicationV2.memberId,
  state: questCandidateApplicationV2.state,
  appliedAt: questCandidateApplicationV2.appliedAt,
};

const toApplicationRow = (row: {
  id: string;
  questId: string;
  memberId: string;
  state: string;
  appliedAt: Date;
}): QuestV2CandidateApplicationRow => {
  if (!(questV2ApplicationStates as readonly string[]).includes(row.state)) {
    throw new Error('Candidate application has an invalid state for Quest API V2');
  }
  return {
    ...row,
    state: row.state as QuestV2ApplicationState,
  };
};

const snapshotFor = (application: QuestV2CandidateApplicationRow) => ({
  id: application.id,
  questId: application.questId,
  memberId: application.memberId,
  state: application.state,
  appliedAt: application.appliedAt.toISOString(),
});

const applicationFromSnapshot = (value: unknown): QuestV2CandidateApplicationRow | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const snapshot = value as Partial<Record<keyof QuestV2CandidateApplicationRow, unknown>>;
  if (
    typeof snapshot.id !== 'string' ||
    typeof snapshot.questId !== 'string' ||
    typeof snapshot.memberId !== 'string' ||
    typeof snapshot.state !== 'string' ||
    typeof snapshot.appliedAt !== 'string' ||
    !(questV2ApplicationStates as readonly string[]).includes(snapshot.state)
  )
    return undefined;
  const appliedAt = new Date(snapshot.appliedAt);
  if (Number.isNaN(appliedAt.getTime())) return undefined;
  return {
    id: snapshot.id,
    questId: snapshot.questId,
    memberId: snapshot.memberId,
    state: snapshot.state as QuestV2ApplicationState,
    appliedAt,
  };
};

const lockQuest = async (transaction: QuestTransaction, questId: string) => {
  const [current] = await transaction
    .select({
      hirerId: quest.hirerId,
      v2Mode: quest.v2Mode,
      v2Participation: quest.v2Participation,
      questState: quest.questStatus,
      hiddenAt: quest.hiddenAt,
      startTime: quest.startTime,
    })
    .from(quest)
    .where(and(eq(quest.id, questId), eq(quest.apiVersion, questApiVersion.v2)))
    .limit(1)
    .for('update');
  return current;
};

const isReadableQuest = (current: {
  v2Mode: string | null;
  v2Participation: string | null;
  questState: string;
}) =>
  current.v2Mode === questV2Mode.candidate &&
  current.v2Participation === questV2Participation.single &&
  (current.questState === 'QUEST_OPEN' || current.questState === 'QUEST_ASSIGNED');

export const createQuestV2CandidateApplication = async (
  memberId: string,
  questId: string,
  rawCommandId: string,
  now = new Date()
): Promise<QuestV2CandidateApplicationOutcome> =>
  db.transaction(async (transaction) => {
    // The Quest row is locked before the module records the command. The command row's
    // quest foreign key takes FOR KEY SHARE on the Quest row, so taking the caller's
    // FOR UPDATE after the module's insert deadlocks two concurrent commands that
    // target the same Quest.
    const current = await lockQuest(transaction, questId);
    if (!current) return { outcome: 'not-found' };

    const command = await runQuestCommand({
      transaction,
      identity: {
        principalUserId: memberId,
        operationScope: questV2CandidateApplicationCreateOperationScope,
        key: rawCommandId,
        requestHash: await sha256Json({
          authenticatedMemberId: memberId,
          operation: questV2CandidateApplicationCreateOperationScope,
          path: '/api/v2/quests/:questId/applications',
          questId,
          body: {},
        }),
        questId,
      },
      now,
      work: async (): Promise<
        QuestCommandWork<QuestV2CandidateApplicationRow, CandidateApplicationBusinessOutcomeCode>
      > => {
        if (current.v2Mode !== questV2Mode.candidate) {
          return { kind: 'rejected', rejection: 'not-candidate' };
        }
        if (current.v2Participation !== questV2Participation.single) {
          return { kind: 'rejected', rejection: 'not-single' };
        }
        if (current.hirerId === memberId) {
          return { kind: 'rejected', rejection: 'hirer-not-allowed' };
        }
        // A hidden Quest is out of reach for Members, so it refuses an application the same
        // way a Quest that is not open does. Withdrawal below stays open, so hiding a Quest
        // does not trap the Members already on it.
        if (current.questState !== 'QUEST_OPEN' || current.hiddenAt !== null) {
          return { kind: 'rejected', rejection: 'not-open' };
        }
        if (current.startTime.getTime() <= now.getTime()) {
          return { kind: 'rejected', rejection: 'not-open' };
        }

        const [existing] = await transaction
          .select({ id: questCandidateApplicationV2.id })
          .from(questCandidateApplicationV2)
          .where(
            and(
              eq(questCandidateApplicationV2.questId, questId),
              eq(questCandidateApplicationV2.memberId, memberId)
            )
          )
          .limit(1);
        if (existing) return { kind: 'rejected', rejection: 'already-exists' };

        const [createdApplication] = await transaction
          .insert(questCandidateApplicationV2)
          .values({
            questId,
            memberId,
            state: 'APPLICATION_APPLIED',
            appliedAt: now,
          })
          .returning(applicationFields);
        if (!createdApplication) throw new Error('Candidate application insert returned no row');

        const application = toApplicationRow(createdApplication);
        return {
          kind: 'success',
          result: application,
          resourceType: 'quest-v2-candidate-application',
          resourceId: application.id,
        };
      },
      toSnapshot: snapshotFor,
      fromSnapshot: applicationFromSnapshot,
    });

    if ('outcome' in command) return { outcome: command.outcome };
    if (command.kind === 'success') return command.result;
    return { outcome: command.rejection };
  });

type QuestV2CandidateApplicationWithdrawBusinessOutcomeCode =
  | 'application-not-found'
  | 'hirer-not-allowed'
  | 'not-candidate'
  | 'not-open'
  | 'not-single'
  | 'not-withdrawable';

type QuestV2CandidateApplicationWithdrawOutcomeCode =
  QuestV2CandidateApplicationWithdrawBusinessOutcomeCode | 'not-found' | QuestCommandOutcomeCode;

export type QuestV2CandidateApplicationWithdrawOutcome =
  | QuestV2CandidateApplicationRow
  | {
      outcome: QuestV2CandidateApplicationWithdrawOutcomeCode;
    };

export const withdrawQuestV2CandidateApplication = async (
  memberId: string,
  questId: string,
  applicationId: string,
  rawCommandId: string,
  now = new Date()
): Promise<QuestV2CandidateApplicationWithdrawOutcome> =>
  db.transaction(async (transaction) => {
    // Lock the Quest row before the command; see the lock-order note in
    // createQuestV2CandidateApplication.
    const current = await lockQuest(transaction, questId);
    if (!current) return { outcome: 'not-found' };

    const command = await runQuestCommand({
      transaction,
      identity: {
        principalUserId: memberId,
        operationScope: questV2CandidateApplicationWithdrawOperationScope,
        key: rawCommandId,
        requestHash: await sha256Json({
          authenticatedMemberId: memberId,
          operation: questV2CandidateApplicationWithdrawOperationScope,
          path: '/api/v2/quests/:questId/applications/:applicationId/withdraw',
          questId,
          applicationId,
          body: {},
        }),
        questId,
      },
      now,
      work: async (): Promise<
        QuestCommandWork<
          QuestV2CandidateApplicationRow,
          QuestV2CandidateApplicationWithdrawBusinessOutcomeCode
        >
      > => {
        if (current.v2Mode !== questV2Mode.candidate) {
          return { kind: 'rejected', rejection: 'not-candidate' };
        }
        if (current.v2Participation !== questV2Participation.single) {
          return { kind: 'rejected', rejection: 'not-single' };
        }
        if (current.hirerId === memberId) {
          return { kind: 'rejected', rejection: 'hirer-not-allowed' };
        }
        if (current.questState !== 'QUEST_OPEN') {
          return { kind: 'rejected', rejection: 'not-open' };
        }
        if (current.startTime.getTime() <= now.getTime()) {
          return { kind: 'rejected', rejection: 'not-open' };
        }

        const [application] = await transaction
          .select(applicationFields)
          .from(questCandidateApplicationV2)
          .where(
            and(
              eq(questCandidateApplicationV2.id, applicationId),
              eq(questCandidateApplicationV2.questId, questId),
              eq(questCandidateApplicationV2.memberId, memberId)
            )
          )
          .limit(1)
          .for('update');
        if (!application) return { kind: 'rejected', rejection: 'application-not-found' };
        if (application.state !== 'APPLICATION_APPLIED') {
          return { kind: 'rejected', rejection: 'not-withdrawable' };
        }

        const [updatedApplication] = await transaction
          .update(questCandidateApplicationV2)
          .set({ state: 'APPLICATION_WITHDRAWN' })
          .where(eq(questCandidateApplicationV2.id, applicationId))
          .returning(applicationFields);
        if (!updatedApplication) {
          throw new Error('Candidate application update returned no row');
        }

        const updated = toApplicationRow(updatedApplication);
        return {
          kind: 'success',
          result: updated,
          resourceType: 'quest-v2-candidate-application',
          resourceId: updated.id,
        };
      },
      toSnapshot: snapshotFor,
      fromSnapshot: applicationFromSnapshot,
    });

    if ('outcome' in command) return { outcome: command.outcome };
    if (command.kind === 'success') return command.result;
    return { outcome: command.rejection };
  });

type QuestV2CandidateSelectionAssignmentRow = {
  id: string;
  questId: string;
  workerId: string;
  state: QuestV2AssignmentState;
  startedAt: Date | null;
  createdAt: Date;
  questState: 'QUEST_ASSIGNED';
};

type QuestV2CandidateSelectionBusinessOutcomeCode =
  'already-assigned' | 'application-not-found' | 'not-allowed' | 'not-open' | 'not-selectable';

type QuestV2CandidateSelectionOutcomeCode =
  QuestV2CandidateSelectionBusinessOutcomeCode | 'not-found' | QuestCommandOutcomeCode;

type QuestV2CandidateSelectionSuccess = {
  assignments: QuestV2CandidateSelectionAssignmentRow[];
  questState: 'QUEST_ASSIGNED';
};

export type QuestV2CandidateSelectionOutcome =
  QuestV2CandidateSelectionSuccess | { outcome: QuestV2CandidateSelectionOutcomeCode };

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
}): QuestV2CandidateSelectionAssignmentRow => {
  if (!(questV2AssignmentStates as readonly string[]).includes(row.state)) {
    throw new Error('Assignment has an invalid state for Quest API V2');
  }
  return {
    ...row,
    state: row.state as QuestV2AssignmentState,
    questState: 'QUEST_ASSIGNED',
  };
};

const selectionSnapshotFor = (result: QuestV2CandidateSelectionSuccess) => ({
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

const selectionFromSnapshot = (value: unknown): QuestV2CandidateSelectionSuccess | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const snapshot = value as {
    questState?: unknown;
    assignments?: unknown;
  };
  if (snapshot.questState !== 'QUEST_ASSIGNED' || !Array.isArray(snapshot.assignments)) {
    return undefined;
  }
  const assignments: QuestV2CandidateSelectionAssignmentRow[] = [];
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

const selectionTransitionFor = (
  questId: string,
  hirerId: string,
  now: Date,
  assignment: QuestV2CandidateSelectionAssignmentRow
): QuestWorkChatMembershipTransition => {
  const commandId = `quest-candidate-selection-v2:${assignment.id}`;
  const worker: AcceptedWorker = {
    workerId: assignment.workerId,
    assignmentId: assignment.id,
    joinedAt: assignment.createdAt.toISOString(),
  };
  return {
    producer: 'QUEST_CANDIDATE_SELECTION',
    type: 'workersAccepted',
    commandId,
    eventId: assignment.id,
    questId,
    actorId: hirerId,
    occurredAt: now.toISOString(),
    hirerId,
    workers: [worker],
  };
};

export const selectQuestV2CandidateApplication = async (
  hirerId: string,
  questId: string,
  applicationId: string,
  rawCommandId: string,
  now = new Date()
): Promise<QuestV2CandidateSelectionOutcome> =>
  db.transaction(async (transaction) => {
    // Lock the Quest row before the command; see the lock-order note in
    // createQuestV2CandidateApplication.
    const current = await lockQuest(transaction, questId);
    if (!current) return { outcome: 'not-found' };

    const command = await runQuestCommand({
      transaction,
      identity: {
        principalUserId: hirerId,
        operationScope: questV2CandidateApplicationSelectOperationScope,
        key: rawCommandId,
        requestHash: await sha256Json({
          authenticatedMemberId: hirerId,
          operation: questV2CandidateApplicationSelectOperationScope,
          path: '/api/v2/quests/:questId/applications/:applicationId/select',
          questId,
          applicationId,
          body: {},
        }),
        questId,
      },
      now,
      work: async (): Promise<
        QuestCommandWork<
          QuestV2CandidateSelectionSuccess,
          QuestV2CandidateSelectionBusinessOutcomeCode
        >
      > => {
        if (current.hirerId !== hirerId) return { kind: 'rejected', rejection: 'not-allowed' };
        if (
          current.v2Mode !== questV2Mode.candidate ||
          current.v2Participation !== questV2Participation.single
        ) {
          return { kind: 'rejected', rejection: 'not-allowed' };
        }
        if (current.questState !== 'QUEST_OPEN') {
          return { kind: 'rejected', rejection: 'not-open' };
        }
        if (current.startTime.getTime() <= now.getTime()) {
          return { kind: 'rejected', rejection: 'not-open' };
        }

        const [application] = await transaction
          .select(applicationFields)
          .from(questCandidateApplicationV2)
          .where(
            and(
              eq(questCandidateApplicationV2.id, applicationId),
              eq(questCandidateApplicationV2.questId, questId)
            )
          )
          .limit(1)
          .for('update');
        if (!application) return { kind: 'rejected', rejection: 'application-not-found' };
        if (application.state !== 'APPLICATION_APPLIED') {
          return { kind: 'rejected', rejection: 'not-selectable' };
        }

        const assignmentRows = await transaction
          .select(assignmentFields)
          .from(questAssignment)
          .where(eq(questAssignment.questId, questId))
          .for('update');
        if (assignmentRows.some((assignment) => assignment.workerId === application.memberId)) {
          return { kind: 'rejected', rejection: 'already-assigned' };
        }

        await transaction
          .update(questCandidateApplicationV2)
          .set({ state: 'APPLICATION_SELECTED' })
          .where(eq(questCandidateApplicationV2.id, application.id));
        await transaction
          .update(questCandidateApplicationV2)
          .set({ state: 'APPLICATION_REJECTED' })
          .where(
            and(
              eq(questCandidateApplicationV2.questId, questId),
              eq(questCandidateApplicationV2.state, 'APPLICATION_APPLIED'),
              ne(questCandidateApplicationV2.id, application.id)
            )
          );

        const [createdAssignment] = await transaction
          .insert(questAssignment)
          .values({
            questId,
            workerId: application.memberId,
            assignmentStatus: 'ASSIGNMENT_ACTIVE',
            createdAt: now,
          })
          .returning(assignmentFields);
        if (!createdAssignment) throw new Error('Assignment insert returned no row');

        await transaction
          .update(quest)
          .set({ questStatus: 'QUEST_ASSIGNED', updatedAt: now })
          .where(and(eq(quest.id, questId), eq(quest.questStatus, 'QUEST_OPEN')));

        const assignment = toSelectionAssignment(createdAssignment);
        const writer = getQuestWorkChatMembershipWriter();
        if (!writer) {
          throw new WorkChatTransitionError(
            new Error('Work Chat membership writer is not configured')
          );
        }
        try {
          await writer.applyQuestTransition(
            transaction,
            selectionTransitionFor(questId, hirerId, now, assignment)
          );
        } catch (cause) {
          throw new WorkChatTransitionError(cause);
        }

        const result: QuestV2CandidateSelectionSuccess = {
          assignments: [assignment],
          questState: 'QUEST_ASSIGNED',
        };
        return {
          kind: 'success',
          result,
          resourceType: 'quest-v2-candidate-selection',
          resourceId: assignment.id,
        };
      },
      toSnapshot: selectionSnapshotFor,
      fromSnapshot: selectionFromSnapshot,
    });

    if ('outcome' in command) return { outcome: command.outcome };
    if (command.kind === 'success') return command.result;
    return { outcome: command.rejection };
  });

export const listQuestV2CandidateApplications = async (
  memberId: string,
  questId: string
): Promise<QuestV2CandidateApplicationReadOutcome> => {
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
  if (!current || !isReadableQuest(current)) return { outcome: 'not-found' };

  const rows = await db
    .select(applicationFields)
    .from(questCandidateApplicationV2)
    .where(
      and(
        eq(questCandidateApplicationV2.questId, questId),
        ...(current.hirerId === memberId
          ? []
          : [eq(questCandidateApplicationV2.memberId, memberId)])
      )
    )
    .orderBy(asc(questCandidateApplicationV2.appliedAt), asc(questCandidateApplicationV2.id));
  if (current.hirerId !== memberId && rows.length === 0) return { outcome: 'not-authorized' };
  return rows.map(toApplicationRow);
};

export const getQuestV2CandidateApplication = async (
  memberId: string,
  questId: string,
  applicationId: string
): Promise<QuestV2CandidateApplicationDetailOutcome> => {
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
  if (!current || !isReadableQuest(current)) return { outcome: 'not-found' };

  const [row] = await db
    .select(applicationFields)
    .from(questCandidateApplicationV2)
    .where(
      and(
        eq(questCandidateApplicationV2.id, applicationId),
        eq(questCandidateApplicationV2.questId, questId),
        ...(current.hirerId === memberId
          ? []
          : [eq(questCandidateApplicationV2.memberId, memberId)])
      )
    )
    .limit(1);
  if (!row) {
    return current.hirerId === memberId
      ? { outcome: 'application-not-found' }
      : { outcome: 'not-authorized' };
  }
  return toApplicationRow(row);
};
