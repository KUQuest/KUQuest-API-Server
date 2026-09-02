import { db } from '@/database/client';
import {
  proofSubmission,
  quest,
  questAssignment,
  questCompletionConfirmation,
  questEditRequest,
  questTeam,
  questTeamInvitation,
} from '@/database/schema/quest.schema';

import { and, asc, eq, inArray, lte } from 'drizzle-orm';

import { assignmentStatus, questMode, questParticipation, questStatus } from './quest.contract';
import { autoApproveDueProofs } from './quest-proof.service';
import { cancelUnfilledQuest } from './quest-settlement.service';
import { expireQuestEditRequest } from './quest.service';
import {
  expireQuestV2EditRequest,
  hasPendingQuestV2EditRequest,
  pendingQuestV2EditRequestIds,
} from './quest-v2-edit.service';
import {
  cleanupQuestV2ImageObjects,
  recoverQuestV2ImageUploadManifests,
  retryQuestV2ImageCleanupManifests,
} from './quest-v2.service';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const DEFAULT_BATCH_SIZE = 100;
const dueDisputeStatuses = [questStatus.inProgress, questStatus.submitted, questStatus.rework] as const;
const validProofStatuses = ['PROOF_PENDING', 'PROOF_APPROVED', 'PROOF_AUTO_APPROVED'] as const;

/** The only time source used by the lifecycle worker. */
export interface QuestLifecycleClock {
  now(): Date;
}

export const systemQuestLifecycleClock: QuestLifecycleClock = {
  now: () => new Date(),
};

export type QuestLifecycleWorkerOptions = {
  clock?: QuestLifecycleClock;
  batchSize?: number;
  autoApprove?: typeof autoApproveDueProofs;
  onError?: (error: QuestLifecycleWorkerError) => void;
};

export type QuestLifecycleWorkerError = {
  operation: 'start' | 'auto-cancel' | 'dispute' | 'invitation-expiry' | 'edit-timeout' | 'auto-approval' | 'quest-image-cleanup';
  id?: string;
  cause: unknown;
};

export type QuestLifecycleWorkerResult = {
  startedQuestIds: string[];
  autoCancelledQuestIds: string[];
  disputedQuestIds: string[];
  timedOutEditRequestIds: string[];
  expiredInvitationIds: string[];
  autoApprovedProofIds: string[];
  errors: QuestLifecycleWorkerError[];
};

const boundedSize = (value: number | undefined) => {
  if (value === undefined) return DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(value) || value < 1) throw new Error('batchSize must be a positive integer');
  return value;
};

const startQuest = async (questId: string, now: Date): Promise<boolean> => db.transaction(async (transaction) => {
  const [current] = await transaction
    .select({ id: quest.id, startTime: quest.startTime })
    .from(quest)
    .where(and(eq(quest.id, questId), eq(quest.questStatus, questStatus.assigned), lte(quest.startTime, now)))
    .limit(1)
    .for('update');
  if (!current) return false;
  if (await hasPendingQuestV2EditRequest(transaction, questId)) return false;

  await transaction
    .select({ id: questAssignment.id })
    .from(questAssignment)
    .where(and(eq(questAssignment.questId, questId), eq(questAssignment.assignmentStatus, assignmentStatus.active)))
    .for('update');

  await transaction
    .update(questAssignment)
    .set({ startedAt: now })
    .where(and(eq(questAssignment.questId, questId), eq(questAssignment.assignmentStatus, assignmentStatus.active)));
  const [updated] = await transaction
    .update(quest)
    .set({ questStatus: questStatus.inProgress, updatedAt: now })
    .where(and(eq(quest.id, questId), eq(quest.questStatus, questStatus.assigned)))
    .returning({ id: quest.id });

  return Boolean(updated);
});

const ownerHasValidProof = async (transaction: Transaction, questId: string, workerId: string) => {
  const [proof] = await transaction
    .select({ id: proofSubmission.id })
    .from(proofSubmission)
    .where(and(
      eq(proofSubmission.questId, questId),
      eq(proofSubmission.workerId, workerId),
      inArray(proofSubmission.submissionStatus, [...validProofStatuses]),
    ))
    .limit(1);
  return Boolean(proof);
};

const selectedTeamForQuest = async (transaction: Transaction, questId: string) => {
  const [team] = await transaction
    .select({ id: questTeam.id })
    .from(questTeam)
    .where(and(eq(questTeam.questId, questId), eq(questTeam.teamStatus, 'TEAM_SELECTED')))
    .limit(1);
  return team;
};

const questHasIncompleteObligations = async (
  transaction: Transaction,
  current: { id: string; mode: string; participation: string; proofRequired: boolean },
) => {
  const assignments = await transaction
    .select({ workerId: questAssignment.workerId })
    .from(questAssignment)
    .where(and(eq(questAssignment.questId, current.id), eq(questAssignment.assignmentStatus, assignmentStatus.active)))
    .for('update');
  if (assignments.length === 0) return false;

  const selectedTeam = current.mode === questMode.candidate && current.participation === questParticipation.group
    ? await selectedTeamForQuest(transaction, current.id)
    : undefined;

  if (selectedTeam) {
    if (current.proofRequired) {
      const [proof] = await transaction
        .select({ id: proofSubmission.id })
        .from(proofSubmission)
        .where(and(
          eq(proofSubmission.questId, current.id),
          eq(proofSubmission.teamId, selectedTeam.id),
          inArray(proofSubmission.submissionStatus, [...validProofStatuses]),
        ))
        .limit(1);
      return !proof;
    }

    const [confirmation] = await transaction
      .select({ id: questCompletionConfirmation.id })
      .from(questCompletionConfirmation)
      .where(and(eq(questCompletionConfirmation.questId, current.id), eq(questCompletionConfirmation.teamId, selectedTeam.id)))
      .limit(1);
    return !confirmation;
  }

  for (const assignment of assignments) {
    if (current.proofRequired) {
      if (!(await ownerHasValidProof(transaction, current.id, assignment.workerId))) return true;
    } else {
      const [confirmation] = await transaction
        .select({ id: questCompletionConfirmation.id })
        .from(questCompletionConfirmation)
        .where(and(eq(questCompletionConfirmation.questId, current.id), eq(questCompletionConfirmation.workerId, assignment.workerId)))
        .limit(1);
      if (!confirmation) return true;
    }
  }
  return false;
};

const disputeQuest = async (questId: string, now: Date): Promise<boolean> => db.transaction(async (transaction) => {
  const [current] = await transaction
    .select({
      id: quest.id,
      mode: quest.mode,
      participation: quest.participation,
      proofRequired: quest.proofRequired,
      dueAt: quest.dueAt,
      questStatus: quest.questStatus,
    })
    .from(quest)
    .where(and(eq(quest.id, questId), inArray(quest.questStatus, [...dueDisputeStatuses]), lte(quest.dueAt, now)))
    .limit(1)
    .for('update');
  if (!current || !(await questHasIncompleteObligations(transaction, current))) return false;

  const [updated] = await transaction
    .update(quest)
    .set({ questStatus: questStatus.disputed, updatedAt: now })
    .where(and(eq(quest.id, questId), inArray(quest.questStatus, [...dueDisputeStatuses])))
    .returning({ id: quest.id });
  return Boolean(updated);
});

const expireInvitation = async (invitationId: string, now: Date): Promise<boolean> => db.transaction(async (transaction) => {
  const [invitation] = await transaction
    .select({ id: questTeamInvitation.id })
    .from(questTeamInvitation)
    .where(and(
      eq(questTeamInvitation.id, invitationId),
      eq(questTeamInvitation.invitationStatus, 'INVITATION_PENDING'),
      lte(questTeamInvitation.expiresAt, now),
    ))
    .limit(1)
    .for('update');
  if (!invitation) return false;

  const [updated] = await transaction
    .update(questTeamInvitation)
    .set({ invitationStatus: 'INVITATION_EXPIRED', respondedAt: now })
    .where(and(eq(questTeamInvitation.id, invitationId), eq(questTeamInvitation.invitationStatus, 'INVITATION_PENDING')))
    .returning({ id: questTeamInvitation.id });
  return Boolean(updated);
});

const reportError = (onError: QuestLifecycleWorkerOptions['onError'], error: QuestLifecycleWorkerError) => {
  try {
    onError?.(error);
  } catch {
    // Observability must not stop unrelated lifecycle records.
  }
};

const processIds = async (
  ids: readonly string[],
  operation: QuestLifecycleWorkerError['operation'],
  action: (id: string) => Promise<boolean>,
  errors: QuestLifecycleWorkerError[],
  onError?: (error: QuestLifecycleWorkerError) => void,
) => {
  const changed: string[] = [];
  for (const id of ids) {
    try {
      if (await action(id)) changed.push(id);
    } catch (cause) {
      const error = { operation, id, cause };
      errors.push(error);
      reportError(onError, error);
    }
  }
  return changed;
};

const dueQuestIds = async (now: Date, limit: number) => db
  .select({ id: quest.id })
  .from(quest)
  .where(and(inArray(quest.questStatus, [...dueDisputeStatuses]), lte(quest.dueAt, now)))
  .orderBy(asc(quest.dueAt), asc(quest.id))
  .limit(limit);

const dueUnfilledQuestIds = async (now: Date, limit: number) => db
  .select({ id: quest.id })
  .from(quest)
  .where(and(eq(quest.questStatus, questStatus.open), lte(quest.startTime, now)))
  .orderBy(asc(quest.startTime), asc(quest.id))
  .limit(limit);

const pendingEditRequestIds = async (limit: number) => db
  .select({ id: questEditRequest.id })
  .from(questEditRequest)
  .where(eq(questEditRequest.requestStatus, 'EDIT_REQUEST_PENDING'))
  .orderBy(asc(questEditRequest.createdAt), asc(questEditRequest.id))
  .limit(limit);

const timeoutEditRequest = async (requestId: string, now: Date) => expireQuestEditRequest(requestId, now)
  .then((result) => 'status' in result && result.status === 'EDIT_REQUEST_REJECTED');

const timeoutQuestV2EditRequest = (requestId: string, now: Date) =>
  expireQuestV2EditRequest(requestId, now);

const dueInvitationIds = async (now: Date, limit: number) => db
  .select({ id: questTeamInvitation.id })
  .from(questTeamInvitation)
  .where(and(eq(questTeamInvitation.invitationStatus, 'INVITATION_PENDING'), lte(questTeamInvitation.expiresAt, now)))
  .orderBy(asc(questTeamInvitation.expiresAt), asc(questTeamInvitation.id))
  .limit(limit);

/** Start all due assigned Quests in one bounded, retry-safe batch. */
export const startDueAssignedQuests = async (now = new Date(), limit = DEFAULT_BATCH_SIZE) => {
  const ids = await db
    .select({ id: quest.id })
    .from(quest)
    .where(and(eq(quest.questStatus, questStatus.assigned), lte(quest.startTime, now)))
    .orderBy(asc(quest.startTime), asc(quest.id))
    .limit(boundedSize(limit));
  const errors: QuestLifecycleWorkerError[] = [];
  return processIds(ids.map(({ id }) => id), 'start', (id) => startQuest(id, now), errors);
};

/** Cancel every due OPEN Quest that did not reach ASSIGNED. */
export const cancelDueUnfilledQuests = async (now = new Date(), limit = DEFAULT_BATCH_SIZE) => {
  const ids = await dueUnfilledQuestIds(now, boundedSize(limit));
  const errors: QuestLifecycleWorkerError[] = [];
  return processIds(
    ids.map(({ id }) => id),
    'auto-cancel',
    async (id) => {
      const result = await cancelUnfilledQuest(id, now);
      return 'questStatus' in result && result.outcome === 'CANCELLED' && !result.replayed;
    },
    errors,
  );
};

/** Dispute due Quests that still lack a proof or completion confirmation. */
export const disputeOverdueQuests = async (now = new Date(), limit = DEFAULT_BATCH_SIZE) => {
  const ids = await dueQuestIds(now, boundedSize(limit));
  const errors: QuestLifecycleWorkerError[] = [];
  return processIds(ids.map(({ id }) => id), 'dispute', (id) => disputeQuest(id, now), errors);
};

/** Expire pending invitations only from this explicit worker operation. */
export const expirePendingQuestTeamInvitations = async (now = new Date(), limit = DEFAULT_BATCH_SIZE) => {
  const ids = await dueInvitationIds(now, boundedSize(limit));
  const errors: QuestLifecycleWorkerError[] = [];
  return processIds(ids.map(({ id }) => id), 'invitation-expiry', (id) => expireInvitation(id, now), errors);
};

/**
 * Run one deterministic lifecycle sweep. Each Quest and invitation is handled
 * in its own transaction, so one failed record rolls back without stopping the
 * remaining records. The proof service owns auto-approval timing and rules.
 */
export const runQuestLifecycleWorker = async (
  options: QuestLifecycleWorkerOptions = {},
): Promise<QuestLifecycleWorkerResult> => {
  const clock = options.clock ?? systemQuestLifecycleClock;
  const now = clock.now();
  const limit = boundedSize(options.batchSize);
  const errors: QuestLifecycleWorkerError[] = [];

  try {
    await recoverQuestV2ImageUploadManifests(now, limit);
    await retryQuestV2ImageCleanupManifests(limit);
    await cleanupQuestV2ImageObjects(now, limit);
  } catch (cause) {
    const error = { operation: 'quest-image-cleanup' as const, cause };
    errors.push(error);
    reportError(options.onError, error);
  }

  let autoApprovedProofIds: string[] = [];
  try {
    autoApprovedProofIds = await (options.autoApprove ?? autoApproveDueProofs)(now);
  } catch (cause) {
    const error = { operation: 'auto-approval' as const, cause };
    errors.push(error);
    reportError(options.onError, error);
  }

  const timedOutLegacyEditRequestIds = await processIds(
    (await pendingEditRequestIds(limit)).map(({ id }) => id),
    'edit-timeout',
    (id) => timeoutEditRequest(id, now),
    errors,
    options.onError,
  );
  const timedOutV2EditRequestIds = await processIds(
    (await pendingQuestV2EditRequestIds(limit)).map(({ id }) => id),
    'edit-timeout',
    (id) => timeoutQuestV2EditRequest(id, now),
    errors,
    options.onError,
  );
  const startedQuestIds = await processIds(
    (await db.select({ id: quest.id }).from(quest).where(and(eq(quest.questStatus, questStatus.assigned), lte(quest.startTime, now))).orderBy(asc(quest.startTime), asc(quest.id)).limit(limit)).map(({ id }) => id),
    'start',
    (id) => startQuest(id, now),
    errors,
    options.onError,
  );
  const autoCancelledQuestIds = await processIds(
    (await dueUnfilledQuestIds(now, limit)).map(({ id }) => id),
    'auto-cancel',
    async (id) => {
      const result = await cancelUnfilledQuest(id, now);
      return 'questStatus' in result && result.outcome === 'CANCELLED' && !result.replayed;
    },
    errors,
    options.onError,
  );
  const disputedQuestIds = await processIds(
    (await dueQuestIds(now, limit)).map(({ id }) => id),
    'dispute',
    (id) => disputeQuest(id, now),
    errors,
    options.onError,
  );
  const expiredInvitationIds = await processIds(
    (await dueInvitationIds(now, limit)).map(({ id }) => id),
    'invitation-expiry',
    (id) => expireInvitation(id, now),
    errors,
    options.onError,
  );

  return {
    startedQuestIds,
    autoCancelledQuestIds,
    disputedQuestIds,
    timedOutEditRequestIds: [...timedOutLegacyEditRequestIds, ...timedOutV2EditRequestIds],
    expiredInvitationIds,
    autoApprovedProofIds,
    errors,
  };
};

export const runQuestLifecycle = runQuestLifecycleWorker;
export const processQuestLifecycle = runQuestLifecycleWorker;

export const createQuestLifecycleWorker = (options: QuestLifecycleWorkerOptions = {}) => ({
  run: () => runQuestLifecycleWorker(options),
});
