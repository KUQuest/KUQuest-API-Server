import { db } from '@/database/client';
import { isMemberRedFlaggedInTransaction } from '@/modules/admin/member-penalty';
import {
  quest,
  questApiVersion,
  questCandidateApplicationV2,
} from '@/database/schema/quest.schema';

import { and, asc, eq, ne } from 'drizzle-orm';

import {
  runQuestCommand,
  sha256Json,
  type QuestCommandOutcomeCode,
  type QuestCommandWork,
} from '../../shared/command/quest-command.service';
import type {
  AcceptedWorker,
  QuestWorkChatMembershipTransition,
} from '../../shared/work-chat/quest-work-chat.contract';
import {
  questV2ApplicationStates,
  questV2Mode,
  questV2Participation,
  type QuestV2ApplicationState,
} from '../core/quest-v2.contract';
import {
  lockQuest,
  runQuestV2Selection,
  type SelectionAssignmentRow,
  type SelectionSuccess,
} from '../../shared/contracts/quest-selection.service';
import { notifyCandidateRosterUpdate } from '../realtime';
import { isReadableCandidateApplicationRoster } from '../shared/candidate-roster-access.policy';

export const questV2CandidateApplicationCreateOperationScope =
  'quest.v2.candidate-application.create';
export const questV2CandidateApplicationWithdrawOperationScope =
  'quest.v2.candidate-application.withdraw';
export const questV2CandidateApplicationSelectOperationScope =
  'quest.v2.candidate-application.select';
export const questV2CandidateApplicationRejectOperationScope =
  'quest.v2.candidate-application.reject';

type QuestV2CandidateApplicationRow = {
  id: string;
  questId: string;
  memberId: string;
  state: QuestV2ApplicationState;
  appliedAt: Date;
};

type CandidateApplicationBusinessOutcomeCode =
  | 'already-exists'
  | 'hirer-not-allowed'
  | 'not-candidate'
  | 'not-open'
  | 'not-single'
  | 'red-flagged';

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

const isReadableQuest = isReadableCandidateApplicationRoster;

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
        if (await isMemberRedFlaggedInTransaction(transaction, memberId, now)) {
          return { kind: 'rejected', rejection: 'red-flagged' };
        }

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
        await notifyCandidateRosterUpdate(transaction, questId, { kind: 'HIRER' });
        await notifyCandidateRosterUpdate(transaction, questId, {
          kind: 'APPLICATION',
          applicationId: application.id,
        });
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
        await notifyCandidateRosterUpdate(transaction, questId, { kind: 'HIRER' });
        await notifyCandidateRosterUpdate(transaction, questId, {
          kind: 'APPLICATION',
          applicationId: updated.id,
        });
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

type QuestV2CandidateApplicationRejectBusinessOutcomeCode =
  'application-not-found' | 'not-allowed' | 'not-rejectable';

type QuestV2CandidateApplicationRejectOutcomeCode =
  QuestV2CandidateApplicationRejectBusinessOutcomeCode | 'not-found' | QuestCommandOutcomeCode;

export type QuestV2CandidateApplicationRejectOutcome =
  | QuestV2CandidateApplicationRow
  | {
      outcome: QuestV2CandidateApplicationRejectOutcomeCode;
    };

export const rejectQuestV2CandidateApplication = async (
  hirerId: string,
  questId: string,
  applicationId: string,
  rawCommandId: string,
  now = new Date()
): Promise<QuestV2CandidateApplicationRejectOutcome> =>
  db.transaction(async (transaction) => {
    const current = await lockQuest(transaction, questId);
    if (!current) return { outcome: 'not-found' };

    const command = await runQuestCommand({
      transaction,
      identity: {
        principalUserId: hirerId,
        operationScope: questV2CandidateApplicationRejectOperationScope,
        key: rawCommandId,
        requestHash: await sha256Json({
          authenticatedMemberId: hirerId,
          operation: questV2CandidateApplicationRejectOperationScope,
          path: '/api/v2/quests/:questId/applications/:applicationId/reject',
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
          QuestV2CandidateApplicationRejectBusinessOutcomeCode
        >
      > => {
        if (current.hirerId !== hirerId) {
          return { kind: 'rejected', rejection: 'not-allowed' };
        }
        if (
          current.v2Mode !== questV2Mode.candidate ||
          current.v2Participation !== questV2Participation.single ||
          current.questState !== 'QUEST_OPEN' ||
          current.startTime.getTime() <= now.getTime()
        ) {
          return { kind: 'rejected', rejection: 'not-allowed' };
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
          return { kind: 'rejected', rejection: 'not-rejectable' };
        }

        const [updatedApplication] = await transaction
          .update(questCandidateApplicationV2)
          .set({ state: 'APPLICATION_REJECTED' })
          .where(eq(questCandidateApplicationV2.id, applicationId))
          .returning(applicationFields);
        if (!updatedApplication) {
          throw new Error('Candidate application update returned no row');
        }

        const updated = toApplicationRow(updatedApplication);
        await notifyCandidateRosterUpdate(transaction, questId, { kind: 'HIRER' });
        await notifyCandidateRosterUpdate(transaction, questId, {
          kind: 'APPLICATION',
          applicationId: updated.id,
        });
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

type QuestV2CandidateSelectionBusinessOutcomeCode =
  'already-assigned' | 'application-not-found' | 'not-allowed' | 'not-open' | 'not-selectable';

type QuestV2CandidateSelectionOutcomeCode =
  QuestV2CandidateSelectionBusinessOutcomeCode | 'not-found' | QuestCommandOutcomeCode;

export type QuestV2CandidateSelectionOutcome =
  SelectionSuccess | { outcome: QuestV2CandidateSelectionOutcomeCode };

const selectionTransitionFor = ({
  questId,
  hirerId,
  now,
  assignments,
}: {
  questId: string;
  hirerId: string;
  now: Date;
  resourceId: string;
  assignments: SelectionAssignmentRow[];
}): QuestWorkChatMembershipTransition => {
  const [assignment] = assignments;
  if (!assignment) {
    throw new Error('Selection succeeded without creating an assignment');
  }
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
): Promise<QuestV2CandidateSelectionOutcome> => {
  const requestHash = await sha256Json({
    authenticatedMemberId: hirerId,
    operation: questV2CandidateApplicationSelectOperationScope,
    path: '/api/v2/quests/:questId/applications/:applicationId/select',
    questId,
    applicationId,
    body: {},
  });

  return runQuestV2Selection<QuestV2CandidateSelectionBusinessOutcomeCode>({
    hirerId,
    questId,
    rawCommandId,
    now,
    operationScope: questV2CandidateApplicationSelectOperationScope,
    requestHash,
    participation: 'single',
    gates: {
      notHirer: 'not-allowed',
      notMode: 'not-allowed',
      notParticipation: 'not-allowed',
    },
    resourceType: 'quest-v2-candidate-selection',
    selectResource: async (transaction) => {
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

      return {
        kind: 'selected',
        workerIds: [application.memberId],
        resourceId: (assignments) => assignments[0].id,
        flipCandidateRecords: async (tx) => {
          const [selectedApplication] = await tx
            .update(questCandidateApplicationV2)
            .set({ state: 'APPLICATION_SELECTED' })
            .where(eq(questCandidateApplicationV2.id, application.id))
            .returning({ id: questCandidateApplicationV2.id });
          const rejectedApplications = await tx
            .update(questCandidateApplicationV2)
            .set({ state: 'APPLICATION_REJECTED' })
            .where(
              and(
                eq(questCandidateApplicationV2.questId, questId),
                eq(questCandidateApplicationV2.state, 'APPLICATION_APPLIED'),
                ne(questCandidateApplicationV2.id, application.id)
              )
            )
            .returning({ id: questCandidateApplicationV2.id });

          await notifyCandidateRosterUpdate(tx, questId, { kind: 'HIRER' });
          if (selectedApplication) {
            await notifyCandidateRosterUpdate(tx, questId, {
              kind: 'APPLICATION',
              applicationId: selectedApplication.id,
            });
          }
          for (const rejectedApplication of rejectedApplications) {
            await notifyCandidateRosterUpdate(tx, questId, {
              kind: 'APPLICATION',
              applicationId: rejectedApplication.id,
            });
          }
        },
      };
    },
    transitionFor: selectionTransitionFor,
  });
};

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
