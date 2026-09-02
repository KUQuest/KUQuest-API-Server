import { db } from '@/database/client';
import {
  quest,
  questApiVersion,
  questApplication,
  questAssignment,
} from '@/database/schema/quest.schema';
import { walletIdempotencyKey } from '@/database/schema/wallet.schema';

import { and, asc, eq, ne } from 'drizzle-orm';

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
  workerId: string;
  state: QuestV2ApplicationState;
  appliedAt: Date;
};

type CandidateApplicationOutcomeCode =
  | 'already-exists'
  | 'hirer-not-allowed'
  | 'not-candidate'
  | 'not-found'
  | 'not-open'
  | 'not-single'
  | 'idempotency-in-progress'
  | 'idempotency-key-reused'
  | 'idempotency-unavailable'
  | 'invalid-idempotency-key';

type IdempotencyOutcomeCode = Extract<CandidateApplicationOutcomeCode, `idempotency-${string}`>;

export type QuestV2CandidateApplicationOutcome =
  | QuestV2CandidateApplicationRow
  | { outcome: CandidateApplicationOutcomeCode };

export type QuestV2CandidateApplicationReadOutcome =
  | QuestV2CandidateApplicationRow[]
  | { outcome: 'not-authorized' | 'not-found' };

export type QuestV2CandidateApplicationDetailOutcome =
  | QuestV2CandidateApplicationRow
  | { outcome: 'application-not-found' | 'not-authorized' | 'not-found' };

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
  | { outcome: IdempotencyOutcomeCode };

const applicationFields = {
  id: questApplication.id,
  questId: questApplication.questId,
  workerId: questApplication.workerId,
  state: questApplication.applicationStatus,
  appliedAt: questApplication.appliedAt,
};

const idempotencyFields = {
  id: walletIdempotencyKey.id,
  requestHash: walletIdempotencyKey.requestHash,
  resourceId: walletIdempotencyKey.resourceId,
  resultData: walletIdempotencyKey.resultData,
  processingStatus: walletIdempotencyKey.processingStatus,
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

const requestHashFor = (workerId: string, questId: string): Promise<string> =>
  sha256Json({
    authenticatedMemberId: workerId,
    operation: questV2CandidateApplicationCreateOperationScope,
    path: '/api/v2/quests/:questId/applications',
    questId,
    body: {},
  });

const withdrawRequestHashFor = (
  workerId: string,
  questId: string,
  applicationId: string,
): Promise<string> => sha256Json({
  authenticatedMemberId: workerId,
  operation: questV2CandidateApplicationWithdrawOperationScope,
  path: '/api/v2/quests/:questId/applications/:applicationId/withdraw',
  questId,
  applicationId,
  body: {},
});

const selectionRequestHashFor = (
  hirerId: string,
  questId: string,
  applicationId: string,
): Promise<string> => sha256Json({
  authenticatedMemberId: hirerId,
  operation: questV2CandidateApplicationSelectOperationScope,
  path: '/api/v2/quests/:questId/applications/:applicationId/select',
  questId,
  applicationId,
  body: {},
});

const idempotencyExpiry = () => new Date(Date.now() + 24 * 60 * 60 * 1000);

const toApplicationRow = (row: {
  id: string;
  questId: string;
  workerId: string;
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
  workerId: application.workerId,
  state: application.state,
  appliedAt: application.appliedAt.toISOString(),
});

const applicationFromSnapshot = (
  value: unknown,
): QuestV2CandidateApplicationRow | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const snapshot = value as Partial<Record<keyof QuestV2CandidateApplicationRow, unknown>>;
  if (
    typeof snapshot.id !== 'string' ||
    typeof snapshot.questId !== 'string' ||
    typeof snapshot.workerId !== 'string' ||
    typeof snapshot.state !== 'string' ||
    typeof snapshot.appliedAt !== 'string' ||
    !(questV2ApplicationStates as readonly string[]).includes(snapshot.state)
  ) return undefined;
  const appliedAt = new Date(snapshot.appliedAt);
  if (Number.isNaN(appliedAt.getTime())) return undefined;
  return {
    id: snapshot.id,
    questId: snapshot.questId,
    workerId: snapshot.workerId,
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
}) => current.v2Mode === questV2Mode.candidate &&
  current.v2Participation === questV2Participation.single &&
  (current.questState === 'QUEST_OPEN' || current.questState === 'QUEST_ASSIGNED');

const acquireIdempotency = async (
  transaction: QuestTransaction,
  userId: string,
  key: string,
  requestHash: string,
  operationScope: string,
): Promise<IdempotencyAcquireResult> => {
  const [created] = await transaction
    .insert(walletIdempotencyKey)
    .values({
      principalUserId: userId,
      operationScope,
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
    .where(and(
      eq(walletIdempotencyKey.principalUserId, userId),
      eq(walletIdempotencyKey.operationScope, operationScope),
      eq(walletIdempotencyKey.key, key),
    ))
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

export const createQuestV2CandidateApplication = async (
  workerId: string,
  questId: string,
  rawCommandId: string,
  now = new Date(),
): Promise<QuestV2CandidateApplicationOutcome> => {
  const commandId = rawCommandId.trim();
  if (commandId.length === 0 || commandId.length > 200) {
    return { outcome: 'invalid-idempotency-key' };
  }
  const requestHash = await requestHashFor(workerId, questId);

  return db.transaction(async (transaction) => {
    const current = await lockQuest(transaction, questId);
    if (!current) return { outcome: 'not-found' };

    const idempotency = await acquireIdempotency(
      transaction,
      workerId,
      commandId,
      requestHash,
      questV2CandidateApplicationCreateOperationScope,
    );
    if ('outcome' in idempotency) return idempotency;
    if (!idempotency.created) {
      const replay = applicationFromSnapshot(idempotency.record.resultData);
      return replay ? replay : { outcome: 'idempotency-unavailable' };
    }

    const discardIdempotency = async (outcome: CandidateApplicationOutcomeCode) => {
      await transaction
        .delete(walletIdempotencyKey)
        .where(eq(walletIdempotencyKey.id, idempotency.record.id));
      return { outcome };
    };

    if (current.v2Mode !== questV2Mode.candidate) return discardIdempotency('not-candidate');
    if (current.v2Participation !== questV2Participation.single) return discardIdempotency('not-single');
    if (current.hirerId === workerId) return discardIdempotency('hirer-not-allowed');
    if (current.questState !== 'QUEST_OPEN') return discardIdempotency('not-open');

    const [existing] = await transaction
      .select({ id: questApplication.id })
      .from(questApplication)
      .where(and(
        eq(questApplication.questId, questId),
        eq(questApplication.workerId, workerId),
      ))
      .limit(1);
    if (existing) return discardIdempotency('already-exists');

    const [createdApplication] = await transaction
      .insert(questApplication)
      .values({
        questId,
        workerId,
        applicationStatus: 'APPLICATION_APPLIED',
        appliedAt: now,
      })
      .returning(applicationFields);
    if (!createdApplication) return { outcome: 'idempotency-unavailable' };

    const application = toApplicationRow(createdApplication);
    await transaction
      .update(walletIdempotencyKey)
      .set({
        resourceType: 'quest-v2-candidate-application',
        resourceId: application.id,
        resultData: snapshotFor(application),
        processingStatus: 'COMPLETED',
        completedAt: now,
      })
      .where(eq(walletIdempotencyKey.id, idempotency.record.id));

    return application;
  });
};

type QuestV2CandidateApplicationWithdrawOutcomeCode =
  | 'application-not-found'
  | 'hirer-not-allowed'
  | 'not-candidate'
  | 'not-found'
  | 'not-open'
  | 'not-single'
  | 'not-withdrawable'
  | IdempotencyOutcomeCode
  | 'invalid-idempotency-key';

export type QuestV2CandidateApplicationWithdrawOutcome =
  | QuestV2CandidateApplicationRow
  | {
      outcome: QuestV2CandidateApplicationWithdrawOutcomeCode;
    };

export const withdrawQuestV2CandidateApplication = async (
  workerId: string,
  questId: string,
  applicationId: string,
  rawCommandId: string,
  now = new Date(),
): Promise<QuestV2CandidateApplicationWithdrawOutcome> => {
  const commandId = rawCommandId.trim();
  if (commandId.length === 0 || commandId.length > 200) {
    return { outcome: 'invalid-idempotency-key' };
  }
  const requestHash = await withdrawRequestHashFor(workerId, questId, applicationId);

  return db.transaction(async (transaction) => {
    const current = await lockQuest(transaction, questId);
    if (!current) return { outcome: 'not-found' };

    const idempotency = await acquireIdempotency(
      transaction,
      workerId,
      commandId,
      requestHash,
      questV2CandidateApplicationWithdrawOperationScope,
    );
    if ('outcome' in idempotency) return idempotency;
    if (!idempotency.created) {
      const replay = applicationFromSnapshot(idempotency.record.resultData);
      return replay ? replay : { outcome: 'idempotency-unavailable' };
    }

    const discardIdempotency = async (outcome: QuestV2CandidateApplicationWithdrawOutcomeCode) => {
      await transaction
        .delete(walletIdempotencyKey)
        .where(eq(walletIdempotencyKey.id, idempotency.record.id));
      return { outcome };
    };

    if (current.v2Mode !== questV2Mode.candidate) return discardIdempotency('not-candidate');
    if (current.v2Participation !== questV2Participation.single) return discardIdempotency('not-single');
    if (current.hirerId === workerId) return discardIdempotency('hirer-not-allowed');
    if (current.questState !== 'QUEST_OPEN') return discardIdempotency('not-open');

    const [application] = await transaction
      .select(applicationFields)
      .from(questApplication)
      .where(and(
        eq(questApplication.id, applicationId),
        eq(questApplication.questId, questId),
        eq(questApplication.workerId, workerId),
      ))
      .limit(1)
      .for('update');
    if (!application) return discardIdempotency('application-not-found');
    if (application.state !== 'APPLICATION_APPLIED') return discardIdempotency('not-withdrawable');

    const [updatedApplication] = await transaction
      .update(questApplication)
      .set({ applicationStatus: 'APPLICATION_WITHDRAWN' })
      .where(eq(questApplication.id, applicationId))
      .returning(applicationFields);
    if (!updatedApplication) return { outcome: 'idempotency-unavailable' };

    const updated = toApplicationRow(updatedApplication);
    await transaction
      .update(walletIdempotencyKey)
      .set({
        resourceType: 'quest-v2-candidate-application',
        resourceId: updated.id,
        resultData: snapshotFor(updated),
        processingStatus: 'COMPLETED',
        completedAt: now,
      })
      .where(eq(walletIdempotencyKey.id, idempotency.record.id));

    return updated;
  });
};

type QuestV2CandidateSelectionAssignmentRow = {
  id: string;
  questId: string;
  workerId: string;
  state: QuestV2AssignmentState;
  startedAt: Date | null;
  createdAt: Date;
  questState: 'QUEST_ASSIGNED';
};

type QuestV2CandidateSelectionOutcomeCode =
  | 'already-assigned'
  | 'application-not-found'
  | 'idempotency-in-progress'
  | 'idempotency-key-reused'
  | 'idempotency-unavailable'
  | 'invalid-idempotency-key'
  | 'not-allowed'
  | 'not-found'
  | 'not-open'
  | 'not-selectable';

export type QuestV2CandidateSelectionOutcome =
  | {
      assignments: QuestV2CandidateSelectionAssignmentRow[];
      questState: 'QUEST_ASSIGNED';
    }
  | { outcome: QuestV2CandidateSelectionOutcomeCode };

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

const selectionSnapshotFor = (result: {
  assignments: QuestV2CandidateSelectionAssignmentRow[];
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
): QuestV2CandidateSelectionOutcome | undefined => {
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
    if (!snapshotValue || typeof snapshotValue !== 'object' || Array.isArray(snapshotValue)) return undefined;
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
    ) return undefined;
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
  assignment: QuestV2CandidateSelectionAssignmentRow,
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
  now = new Date(),
): Promise<QuestV2CandidateSelectionOutcome> => {
  const commandId = rawCommandId.trim();
  if (commandId.length === 0 || commandId.length > 200) {
    return { outcome: 'invalid-idempotency-key' };
  }
  const requestHash = await selectionRequestHashFor(hirerId, questId, applicationId);

  return db.transaction(async (transaction) => {
    const current = await lockQuest(transaction, questId);
    if (!current) return { outcome: 'not-found' };

    const idempotency = await acquireIdempotency(
      transaction,
      hirerId,
      commandId,
      requestHash,
      questV2CandidateApplicationSelectOperationScope,
    );
    if ('outcome' in idempotency) return idempotency;
    if (!idempotency.created) {
      const replay = selectionFromSnapshot(idempotency.record.resultData);
      return replay ?? { outcome: 'idempotency-unavailable' };
    }

    const discardIdempotency = async (outcome: QuestV2CandidateSelectionOutcomeCode) => {
      await transaction
        .delete(walletIdempotencyKey)
        .where(eq(walletIdempotencyKey.id, idempotency.record.id));
      return { outcome };
    };

    if (current.hirerId !== hirerId) return discardIdempotency('not-allowed');
    if (current.v2Mode !== questV2Mode.candidate || current.v2Participation !== questV2Participation.single) {
      return discardIdempotency('not-allowed');
    }
    if (current.questState !== 'QUEST_OPEN') return discardIdempotency('not-open');

    const [application] = await transaction
      .select(applicationFields)
      .from(questApplication)
      .where(and(
        eq(questApplication.id, applicationId),
        eq(questApplication.questId, questId),
      ))
      .limit(1)
      .for('update');
    if (!application) return discardIdempotency('application-not-found');
    if (application.state !== 'APPLICATION_APPLIED') return discardIdempotency('not-selectable');

    const assignmentRows = await transaction
      .select(assignmentFields)
      .from(questAssignment)
      .where(eq(questAssignment.questId, questId))
      .for('update');
    if (assignmentRows.some((assignment) => assignment.workerId === application.workerId)) {
      return discardIdempotency('already-assigned');
    }

    await transaction
      .update(questApplication)
      .set({ applicationStatus: 'APPLICATION_SELECTED' })
      .where(eq(questApplication.id, application.id));
    await transaction
      .update(questApplication)
      .set({ applicationStatus: 'APPLICATION_REJECTED' })
      .where(and(
        eq(questApplication.questId, questId),
        eq(questApplication.applicationStatus, 'APPLICATION_APPLIED'),
        ne(questApplication.id, application.id),
      ));

    const [createdAssignment] = await transaction
      .insert(questAssignment)
      .values({
        questId,
        workerId: application.workerId,
        assignmentStatus: 'ASSIGNMENT_ACTIVE',
        createdAt: now,
      })
      .returning(assignmentFields);
    if (!createdAssignment) return { outcome: 'idempotency-unavailable' };

    await transaction
      .update(quest)
      .set({ questStatus: 'QUEST_ASSIGNED', updatedAt: now })
      .where(and(eq(quest.id, questId), eq(quest.questStatus, 'QUEST_OPEN')));

    const assignment = toSelectionAssignment(createdAssignment);
    const writer = getQuestWorkChatMembershipWriter();
    if (!writer) {
      throw new WorkChatTransitionError(new Error('Work Chat membership writer is not configured'));
    }
    try {
      await writer.applyQuestTransition(
        transaction,
        selectionTransitionFor(questId, hirerId, now, assignment),
      );
    } catch (cause) {
      throw new WorkChatTransitionError(cause);
    }

    const result = { assignments: [assignment], questState: 'QUEST_ASSIGNED' as const };
    await transaction
      .update(walletIdempotencyKey)
      .set({
        resourceType: 'quest-v2-candidate-selection',
        resourceId: assignment.id,
        resultData: selectionSnapshotFor(result),
        processingStatus: 'COMPLETED',
        completedAt: now,
      })
      .where(eq(walletIdempotencyKey.id, idempotency.record.id));
    return result;
  });
};

export const listQuestV2CandidateApplications = async (
  memberId: string,
  questId: string,
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
    .from(questApplication)
    .where(and(
      eq(questApplication.questId, questId),
      ...(current.hirerId === memberId ? [] : [eq(questApplication.workerId, memberId)]),
    ))
    .orderBy(asc(questApplication.appliedAt), asc(questApplication.id));
  if (current.hirerId !== memberId && rows.length === 0) return { outcome: 'not-authorized' };
  return rows.map(toApplicationRow);
};

export const getQuestV2CandidateApplication = async (
  memberId: string,
  questId: string,
  applicationId: string,
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
    .from(questApplication)
    .where(and(
      eq(questApplication.id, applicationId),
      eq(questApplication.questId, questId),
      ...(current.hirerId === memberId ? [] : [eq(questApplication.workerId, memberId)]),
    ))
    .limit(1);
  if (!row) {
    return current.hirerId === memberId
      ? { outcome: 'application-not-found' }
      : { outcome: 'not-authorized' };
  }
  return toApplicationRow(row);
};
