import { db } from '@/database/client';
import { recordAudit, type AuditActor } from '@/modules/audit/audit.service';
import {
  paymentMoneyPolicyRevision,
  walletFundingReservation,
} from '@/database/schema/wallet.schema';
import {
  quest,
  questAssignment,
  questCandidateTeamV2,
  questV2UnderfilledDecision,
  questV2UnderfilledConsent,
  questV2ProofSubmission,
  questSettlementCommand,
  questTeam,
} from '@/database/schema/quest.schema';
import {
  calculatePlatformFeeSatang,
  MoneyDomainError,
  positiveSatang,
  releaseFundingReservation,
  satang,
  settleFundingReservation,
  type Satang,
} from '@/modules/wallet';

import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { requireQuestWorkChatMembershipWriter, WorkChatTransitionError } from './quest-assignment.service';
import { assignmentStatus, questStatus, teamStatus, type QuestStatus } from './quest.contract';
import type { QuestTransaction } from './quest-assignment.service';
import { hasPendingQuestV2EditRequest } from './quest-v2-edit.service';
import type { InactiveAssignmentStatus } from './quest-work-chat.contract';

export type QuestSettlementOutcome =
  | { outcome: 'not-found' | 'not-authorized' | 'invalid-state' | 'invalid-idempotency-key' | 'idempotency-key-reused' | 'idempotency-key-required' | 'idempotency-unavailable' | 'allocations-invalid' }
  | { questStatus: QuestStatus; outcome: 'COMPLETED' | 'CANCELLED' | 'REFUNDED' | 'RELEASED_TO_WORKER'; paidSatang: number; refundedSatang: number };

type Actor = { userId?: string; adminId?: string };
type CommandType = 'COMPLETE' | 'CANCEL' | 'AUTO_CANCEL' | 'DISPUTE_REFUND' | 'DISPUTE_RELEASE';
type Allocation = { workerId: string; amountSatang: number };
type CommandResult = Extract<QuestSettlementOutcome, { questStatus: QuestStatus }>;

export const questV2CancellationOperationScope = 'quest.v2.cancellation';
const questV2CancellationPath = '/api/v2/quests/:questId/cancel';

const hash = async (value: unknown) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const commandFields = {
  commandId: questSettlementCommand.commandId,
  questId: questSettlementCommand.questId,
  actorUserId: questSettlementCommand.actorUserId,
  actorAdminId: questSettlementCommand.actorAdminId,
  commandType: questSettlementCommand.commandType,
  requestHash: questSettlementCommand.requestHash,
  resultData: questSettlementCommand.resultData,
  processingStatus: questSettlementCommand.processingStatus,
};

type CommandRow = {
  commandId: string;
  questId: string;
  actorUserId: string | null;
  actorAdminId: string | null;
  commandType: string;
  requestHash: string;
  resultData: unknown;
  processingStatus: string;
};

const acquireCommand = async (
  tx: QuestTransaction,
  input: { commandId: string; questId: string; commandType: CommandType; requestHash: string; actor: Actor; now: Date },
): Promise<{ created: true } | { replay: CommandResult } | { outcome: 'idempotency-key-reused' | 'idempotency-in-progress' | 'idempotency-unavailable' }> => {
  const existing = (await tx.select(commandFields).from(questSettlementCommand)
    .where(eq(questSettlementCommand.commandId, input.commandId)).limit(1).for('update'))[0] as CommandRow | undefined;
  const replay = (row: CommandRow) => {
    if (row.questId !== input.questId || row.commandType !== input.commandType || row.requestHash !== input.requestHash) return { outcome: 'idempotency-key-reused' as const };
    if (row.processingStatus !== 'COMPLETED' || !row.resultData) return { outcome: 'idempotency-unavailable' as const };
    return { replay: row.resultData as CommandResult };
  };
  if (existing) return replay(existing);
  const [created] = await tx.insert(questSettlementCommand).values({
    commandId: input.commandId,
    questId: input.questId,
    actorUserId: input.actor.userId,
    actorAdminId: input.actor.adminId,
    commandType: input.commandType,
    requestHash: input.requestHash,
    createdAt: input.now,
  }).onConflictDoNothing({ target: questSettlementCommand.commandId }).returning(commandFields);
  if (created) return { created: true };
  const concurrent = (await tx.select(commandFields).from(questSettlementCommand)
    .where(eq(questSettlementCommand.commandId, input.commandId)).limit(1).for('update'))[0] as CommandRow | undefined;
  return concurrent ? replay(concurrent) : { outcome: 'idempotency-unavailable' };
};

const finishCommand = async (tx: QuestTransaction, commandId: string, result: CommandResult, now: Date) => {
  await tx.update(questSettlementCommand).set({
    resultData: result,
    processingStatus: 'COMPLETED',
    completedAt: now,
  }).where(eq(questSettlementCommand.commandId, commandId));
};

const reservationFor = async (tx: QuestTransaction, ownerUserId: string, questId: string, lock = true) => {
  const query = tx.select({
    id: walletFundingReservation.id,
    totalReservedSatang: walletFundingReservation.totalReservedSatang,
    remainingSatang: walletFundingReservation.remainingSatang,
    policyRevisionId: walletFundingReservation.policyRevisionId,
    status: walletFundingReservation.status,
  }).from(walletFundingReservation).where(and(
    eq(walletFundingReservation.ownerUserId, ownerUserId),
    eq(walletFundingReservation.callerScope, 'quest'),
    eq(walletFundingReservation.callerReference, questId),
  )).limit(1);
  return (lock ? await query.for('update') : await query)[0];
};

const lockQuest = async (tx: QuestTransaction, questId: string) => (await tx.select({
  id: quest.id,
  hirerId: quest.hirerId,
  apiVersion: quest.apiVersion,
  mode: quest.mode,
  participation: quest.participation,
  questStatus: quest.questStatus,
  v2Mode: quest.v2Mode,
  v2Participation: quest.v2Participation,
  version: quest.version,
  rewardSatang: quest.rewardSatang,
  platformFeePerWorkerSatang: quest.platformFeePerWorkerSatang,
  questEscrowSatang: quest.questEscrowSatang,
  fundingReservationId: quest.fundingReservationId,
  headcount: quest.headcount,
  startTime: quest.startTime,
}).from(quest).where(eq(quest.id, questId)).limit(1).for('update'))[0];

const activeAssignments = async (tx: QuestTransaction, questId: string) => tx.select({
  id: questAssignment.id,
  workerId: questAssignment.workerId,
  createdAt: questAssignment.createdAt,
}).from(questAssignment).where(and(
  eq(questAssignment.questId, questId),
  eq(questAssignment.assignmentStatus, assignmentStatus.active),
)).orderBy(asc(questAssignment.createdAt), asc(questAssignment.id)).for('update');

const selectedTeamLeader = async (tx: QuestTransaction, questId: string): Promise<string | null> => {
  const [team] = await tx.select({ leaderId: questTeam.leaderId })
    .from(questTeam)
    .where(and(
      eq(questTeam.questId, questId),
      eq(questTeam.teamStatus, teamStatus.selected),
    ))
    .limit(1)
    .for('update');
  return team?.leaderId ?? null;
};

const terminalChat = async (
  tx: QuestTransaction,
  current: { id: string; hirerId: string },
  status: 'QUEST_COMPLETED' | 'QUEST_CANCELLED' | 'QUEST_FAILED',
  commandId: string,
  now: Date,
  actorId: string | null = current.hirerId,
) => {
  const writer = requireQuestWorkChatMembershipWriter();
  try {
    await writer.applyQuestTransition(tx, {
      producer: 'QUEST_SETTLEMENT',
      type: 'questBecameReadOnly',
      commandId,
      eventId: commandId,
      questId: current.id,
      actorId,
      occurredAt: now.toISOString(),
      questStatus: status,
      readOnlyAt: now.toISOString(),
    });
  } catch (cause) {
    throw new WorkChatTransitionError(cause);
  }
};

const inactiveWorkersChat = async (
  tx: QuestTransaction,
  current: { id: string },
  workers: { id: string; workerId: string }[],
  status: InactiveAssignmentStatus,
  now: Date,
  actorId: string | null,
): Promise<void> => {
  const writer = requireQuestWorkChatMembershipWriter();
  try {
    for (const worker of workers) {
      await writer.applyQuestTransition(tx, {
        producer: 'QUEST_SETTLEMENT',
        type: 'workerBecameInactive',
        commandId: worker.id,
        eventId: worker.id,
        questId: current.id,
        actorId,
        occurredAt: now.toISOString(),
        assignmentId: worker.id,
        workerId: worker.workerId,
        assignmentStatus: status,
        leftAt: now.toISOString(),
      });
    }
  } catch (cause) {
    throw new WorkChatTransitionError(cause);
  }
};

const policyFee = async (tx: QuestTransaction, policyRevisionId: string, rewardSatang: number) => {
  const [policy] = await tx.select({ platformFeeBps: paymentMoneyPolicyRevision.platformFeeBps })
    .from(paymentMoneyPolicyRevision).where(eq(paymentMoneyPolicyRevision.id, policyRevisionId));
  if (!policy) throw new MoneyDomainError('POLICY_NOT_AVAILABLE', 'Funding Reservation Money Policy is missing.');
  return calculatePlatformFeeSatang(satang(rewardSatang), policy.platformFeeBps);
};

const feeForQuest = async (
  tx: QuestTransaction,
  current: { platformFeePerWorkerSatang: number | null },
  reservation: { policyRevisionId: string },
  rewardSatang: number,
) => current.platformFeePerWorkerSatang === null
  ? policyFee(tx, reservation.policyRevisionId, rewardSatang)
  : satang(current.platformFeePerWorkerSatang);

const requireQuestReward = (rewardSatang: number | null): number => {
  if (rewardSatang === null) {
    throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'Quest Reward is missing.');
  }
  return rewardSatang;
};

const settleWorkers = async (
  tx: QuestTransaction,
  ownerUserId: string,
  reservationId: string,
  workers: { workerId: string; amountSatang: number }[],
  feeFor: (amount: number, workerId?: string) => Promise<Satang | 0>,
  reference: string,
  platformFeeValidation: 'POLICY' | 'QUEST_ESCROW_SNAPSHOT' = 'POLICY',
) => {
  let paid = 0;
  for (const [index, worker] of workers.entries()) {
    const amount = positiveSatang(worker.amountSatang);
    const fee = await feeFor(worker.amountSatang, worker.workerId);
    await settleFundingReservation(tx, {
      ownerUserId,
      reservationId,
      settlementReference: `${reference}:${index}:${worker.workerId}`,
      recipientUserId: worker.workerId,
      recipientAmountSatang: amount,
      platformFeeSatang: fee || undefined,
      platformFeeValidation,
    });
    paid += worker.amountSatang;
  }
  return paid;
};

const releaseRemaining = async (tx: QuestTransaction, ownerUserId: string, reservationId: string, reference: string) => {
  const [before] = await tx.select({ remainingSatang: walletFundingReservation.remainingSatang })
    .from(walletFundingReservation).where(eq(walletFundingReservation.id, reservationId)).limit(1).for('update');
  if (!before) throw new MoneyDomainError('FUNDING_RESERVATION_NOT_FOUND', 'Funding Reservation does not exist.');
  if (before.remainingSatang === 0) return 0;
  await releaseFundingReservation(tx, {
    ownerUserId,
    reservationId,
    operationReference: reference,
  });
  return before.remainingSatang;
};

const completeInTransaction = async (tx: QuestTransaction, questId: string, actorUserId: string, commandId: string, now: Date, allowDisputed = false): Promise<QuestSettlementOutcome> => {
  const current = await lockQuest(tx, questId);
  if (!current) return { outcome: 'not-found' };
  if (current.hirerId !== actorUserId) return { outcome: 'not-authorized' };
  const command = await acquireCommand(tx, {
    commandId,
    questId,
    commandType: 'COMPLETE',
    requestHash: await hash({ command: 'complete', questId, actorUserId }),
    actor: { userId: actorUserId },
    now,
  });
  if ('outcome' in command) {
    if (command.outcome === 'idempotency-in-progress' || command.outcome === 'idempotency-unavailable') return { outcome: 'idempotency-unavailable' };
    return { outcome: command.outcome };
  }
  if ('replay' in command) return command.replay;
  if (current.questStatus !== questStatus.approved && !(allowDisputed && current.questStatus === questStatus.disputed)) {
    await tx.delete(questSettlementCommand).where(eq(questSettlementCommand.commandId, commandId));
    return { outcome: 'invalid-state' };
  }
  const reservation = await reservationFor(tx, current.hirerId, questId);
  // Legacy proof fixtures can reach APPROVED without a published Quest Escrow. A
  // published Quest always has this reservation, and cannot complete without it.
  if (!reservation) {
    await tx.delete(questSettlementCommand).where(eq(questSettlementCommand.commandId, commandId));
    return { outcome: 'invalid-state' };
  }
  const workers = await activeAssignments(tx, questId);
  if (workers.length === 0) {
    await tx.delete(questSettlementCommand).where(eq(questSettlementCommand.commandId, commandId));
    return { outcome: 'invalid-state' };
  }
  const rewardSatang = requireQuestReward(current.rewardSatang);
  const fee = await feeForQuest(tx, current, reservation, rewardSatang);
  const expectedEscrow = current.questEscrowSatang ?? (rewardSatang + Number(fee)) * current.headcount;
  if (reservation.remainingSatang !== expectedEscrow) {
    throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'Quest Escrow does not match the published funding terms.');
  }
  const paid = await settleWorkers(tx, current.hirerId, reservation.id, workers.map(({ workerId }) => ({ workerId, amountSatang: rewardSatang })), () => Promise.resolve(fee), `quest-complete:${commandId}`);
  const remaining = (await reservationFor(tx, current.hirerId, questId, false))?.remainingSatang ?? 0;
  if (remaining !== 0) throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'Quest Escrow does not match the completion payout.');
  await tx.update(questAssignment).set({ assignmentStatus: assignmentStatus.completed }).where(and(eq(questAssignment.questId, questId), eq(questAssignment.assignmentStatus, assignmentStatus.active)));
  await tx.update(quest).set({ questStatus: questStatus.completed, version: sql`${quest.version} + 1`, updatedAt: now }).where(eq(quest.id, questId));
  await terminalChat(tx, current, questStatus.completed, commandId, now);
  const result: CommandResult = { questStatus: questStatus.completed, outcome: 'COMPLETED', paidSatang: paid, refundedSatang: 0 };
  await finishCommand(tx, commandId, result, now);
  return result;
};

/** Complete an approved Quest in the caller's existing transaction. */
export const settleApprovedQuestInTransaction = completeInTransaction;

/** Complete a proof-free v2 Quest after every required work confirmation exists. */
export const settleProofFreeQuestV2InTransaction = async (
  tx: QuestTransaction,
  questId: string,
  commandId: string,
  now: Date,
  completedWorkerId?: string,
  actorId: string | null = null,
): Promise<CommandResult | undefined> => {
  const current = await lockQuest(tx, questId);
  if (!current || current.apiVersion !== 'v2' || current.questStatus !== questStatus.inProgress) {
    throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'The v2 Quest is not ready for completion.');
  }
  const reservation = await reservationFor(tx, current.hirerId, questId);
  if (!reservation || reservation.status !== 'ACTIVE') {
    throw new MoneyDomainError('FUNDING_RESERVATION_NOT_FOUND', 'Quest Escrow is not active.');
  }
  const workers = await activeAssignments(tx, questId);
  if (workers.length === 0) {
    throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'The v2 Quest has no active Assignment.');
  }
  const rewardSatang = requireQuestReward(current.rewardSatang);
  const fee = await feeForQuest(tx, current, reservation, rewardSatang);
  const expectedEscrow = current.questEscrowSatang ?? (rewardSatang + Number(fee)) * current.headcount;
  if (completedWorkerId === undefined && reservation.remainingSatang !== expectedEscrow) {
    throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'Quest Escrow does not match the published funding terms.');
  }
  if (completedWorkerId !== undefined && reservation.remainingSatang > expectedEscrow) {
    throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'Quest Escrow does not match the published funding terms.');
  }

  const groupCandidate = current.v2Mode === 'CANDIDATE' && current.v2Participation === 'GROUP';
  const partialWorker = completedWorkerId === undefined
    ? undefined
    : workers.find(({ workerId }) => workerId === completedWorkerId);
  if (completedWorkerId !== undefined && (!partialWorker || groupCandidate)) {
    throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'The completed Worker Assignment is missing.');
  }
  const underfilledConsents = completedWorkerId === undefined
    ? []
    : await tx.select({
        assignmentId: questV2UnderfilledConsent.assignmentId,
        workerId: questV2UnderfilledConsent.workerId,
        rewardSatang: questV2UnderfilledConsent.rewardSatang,
      })
      .from(questV2UnderfilledConsent)
      .where(and(
        eq(questV2UnderfilledConsent.questId, questId),
        eq(questV2UnderfilledConsent.decision, 'ACCEPT'),
      ))
      .orderBy(asc(questV2UnderfilledConsent.createdAt), asc(questV2UnderfilledConsent.id))
      .for('update');
  const underfilledConsent = completedWorkerId === undefined
    ? undefined
    : underfilledConsents.find(({ assignmentId, workerId }) =>
      assignmentId === partialWorker!.id && workerId === completedWorkerId);
  if (completedWorkerId !== undefined && underfilledConsents.length > 0 && !underfilledConsent) {
    throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'The underfilled Worker Reward allocation is missing.');
  }
  const payoutRewardSatang = underfilledConsent?.rewardSatang ?? rewardSatang;
  const underfilledFeePoolSatang = expectedEscrow - rewardSatang * current.headcount;
  if (
    underfilledConsents.length > 0 &&
    (
      underfilledConsents.length < workers.length ||
      underfilledConsents.reduce((total, consent) => total + consent.rewardSatang, 0) !== rewardSatang * current.headcount ||
      underfilledFeePoolSatang < 0
    )
  ) {
    throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'The underfilled Quest Escrow allocation is inconsistent.');
  }
  const payoutFee = underfilledConsents.length === 0
    ? fee
    : satang(
        Math.floor(underfilledFeePoolSatang / underfilledConsents.length) +
        (underfilledConsents.findIndex(({ assignmentId }) => assignmentId === partialWorker!.id) < underfilledFeePoolSatang % underfilledConsents.length ? 1 : 0),
      );
  let payoutWorkers = completedWorkerId === undefined
    ? workers.map(({ workerId }) => ({ workerId, amountSatang: rewardSatang }))
    : [{ workerId: completedWorkerId, amountSatang: payoutRewardSatang }];
  if (groupCandidate) {
    const [team] = await tx.select({ leaderId: questCandidateTeamV2.leaderId })
      .from(questCandidateTeamV2)
      .where(and(
        eq(questCandidateTeamV2.questId, questId),
        eq(questCandidateTeamV2.state, 'TEAM_SELECTED'),
      ))
      .limit(1)
      .for('update');
    if (!team || !workers.some(({ workerId }) => workerId === team.leaderId)) {
      throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'Selected Team Leader Assignment is missing.');
    }
    payoutWorkers = Array.from({ length: current.headcount }, () => ({
      workerId: team.leaderId,
      amountSatang: rewardSatang,
    }));
  }
  const paid = await settleWorkers(
    tx,
    current.hirerId,
    reservation.id,
    payoutWorkers,
    () => Promise.resolve(payoutFee),
    completedWorkerId === undefined
      ? `quest-v2-complete:${questId}`
      : `quest-v2-complete:${questId}:${completedWorkerId}`,
    underfilledConsents.length === 0 ? 'POLICY' : 'QUEST_ESCROW_SNAPSHOT',
  );
  if (completedWorkerId !== undefined) {
    const assignment = partialWorker;
    if (!assignment) {
      throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'The completed Worker Assignment is missing.');
    }
    await tx.update(questAssignment)
      .set({ assignmentStatus: assignmentStatus.completed })
      .where(and(
        eq(questAssignment.id, assignment.id),
        eq(questAssignment.assignmentStatus, assignmentStatus.active),
      ));
    const remainingWorkers = await activeAssignments(tx, questId);
    if (remainingWorkers.length > 0) {
      await inactiveWorkersChat(tx, current, [assignment], assignmentStatus.completed, now, actorId);
      return undefined;
    }
  }
  const remaining = (await reservationFor(tx, current.hirerId, questId, false))?.remainingSatang ?? 0;
  if (remaining !== 0) {
    throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'Quest Escrow does not match the completion payout.');
  }
  await tx.update(questAssignment)
    .set({ assignmentStatus: assignmentStatus.completed })
    .where(and(
      eq(questAssignment.questId, questId),
      eq(questAssignment.assignmentStatus, assignmentStatus.active),
    ));
  await tx.update(quest)
    .set({
      questStatus: questStatus.completed,
      version: sql`${quest.version} + 1`,
      updatedAt: now,
    })
    .where(and(eq(quest.id, questId), eq(quest.questStatus, questStatus.inProgress)));
  await terminalChat(tx, current, questStatus.completed, commandId, now);
  return {
    questStatus: questStatus.completed,
    outcome: 'COMPLETED',
    paidSatang: paid,
    refundedSatang: 0,
  };
};

export type QuestV2ProofApprovalSettlement = {
  questStatus: QuestStatus;
  paidSatang: number;
  completedAssignmentIds: string[];
};

/** Settle one approved v2 Proof, including a valid post-failure approval. */
export const settleApprovedQuestV2ProofInTransaction = async (
  tx: QuestTransaction,
  questId: string,
  proofSubmissionId: string,
  commandId: string,
  now: Date,
  actorId: string | null = null,
): Promise<QuestV2ProofApprovalSettlement> => {
  const current = await lockQuest(tx, questId);
  if (
    !current ||
    current.apiVersion !== 'v2' ||
    ![questStatus.inProgress, questStatus.failed].includes(current.questStatus as never)
  ) {
    throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'The v2 Quest is not reviewable.');
  }

  const reservation = await reservationFor(tx, current.hirerId, questId);
  if (!reservation || reservation.status !== 'ACTIVE') {
    throw new MoneyDomainError('FUNDING_RESERVATION_NOT_FOUND', 'Quest Escrow is not active.');
  }

  const [submission] = await tx
    .select({
      workerId: questV2ProofSubmission.workerId,
      teamId: questV2ProofSubmission.teamId,
      submissionStatus: questV2ProofSubmission.submissionStatus,
    })
    .from(questV2ProofSubmission)
    .where(and(
      eq(questV2ProofSubmission.id, proofSubmissionId),
      eq(questV2ProofSubmission.questId, questId),
    ))
    .limit(1)
    .for('update');
  if (!submission || submission.submissionStatus !== 'PROOF_APPROVED') {
    throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'The approved Proof Submission is missing.');
  }

  const workers = await activeAssignments(tx, questId);
  if (workers.length === 0) {
    throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'The v2 Quest has no active Assignment.');
  }

  const rewardSatang = requireQuestReward(current.rewardSatang);
  const fee = await feeForQuest(tx, current, reservation, rewardSatang);
  const expectedEscrow = current.questEscrowSatang ?? (rewardSatang + Number(fee)) * current.headcount;
  if (reservation.remainingSatang > expectedEscrow) {
    throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'Quest Escrow does not match the published funding terms.');
  }

  const groupCandidate = current.v2Mode === 'CANDIDATE' && current.v2Participation === 'GROUP';
  const groupFcfs = current.v2Mode === 'FIRST_COME_FIRST_SERVED' && current.v2Participation === 'GROUP';
  let payoutWorkers: { workerId: string; amountSatang: number }[];
  let payoutFee: Satang | 0 = fee;
  let platformFeeValidation: 'POLICY' | 'QUEST_ESCROW_SNAPSHOT' = 'POLICY';
  let completedAssignmentIds: string[];

  if (groupCandidate) {
    const [team] = await tx
      .select({ id: questCandidateTeamV2.id, leaderId: questCandidateTeamV2.leaderId })
      .from(questCandidateTeamV2)
      .where(and(
        eq(questCandidateTeamV2.questId, questId),
        eq(questCandidateTeamV2.state, 'TEAM_SELECTED'),
      ))
      .limit(1)
      .for('update');
    if (!team || team.id !== submission.teamId || !workers.some(({ workerId }) => workerId === team.leaderId)) {
      throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'Selected Team Leader Assignment is missing.');
    }
    payoutWorkers = Array.from({ length: current.headcount }, () => ({
      workerId: team.leaderId,
      amountSatang: rewardSatang,
    }));
    completedAssignmentIds = workers.map(({ id }) => id);
  } else {
    if (!submission.workerId) {
      throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'The approved Worker Assignment is missing.');
    }
    const assignment = workers.find(({ workerId }) => workerId === submission.workerId);
    if (!assignment) {
      throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'The approved Worker Assignment is missing.');
    }

    let payoutRewardSatang = rewardSatang;
    if (groupFcfs) {
      const underfilledConsents = await tx
        .select({ assignmentId: questV2UnderfilledConsent.assignmentId, workerId: questV2UnderfilledConsent.workerId, rewardSatang: questV2UnderfilledConsent.rewardSatang })
        .from(questV2UnderfilledConsent)
        .where(and(
          eq(questV2UnderfilledConsent.questId, questId),
          eq(questV2UnderfilledConsent.decision, 'ACCEPT'),
        ))
        .orderBy(asc(questV2UnderfilledConsent.createdAt), asc(questV2UnderfilledConsent.id))
        .for('update');
      if (underfilledConsents.length > 0) {
        const allocation = underfilledConsents.find(({ assignmentId, workerId }) =>
          assignmentId === assignment.id && workerId === submission.workerId);
        const feePoolSatang = expectedEscrow - rewardSatang * current.headcount;
        if (
          !allocation ||
          underfilledConsents.length > current.headcount ||
          underfilledConsents.reduce((total, consent) => total + consent.rewardSatang, 0) !== rewardSatang * current.headcount ||
          feePoolSatang < 0
        ) {
          throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'The underfilled Quest Escrow allocation is inconsistent.');
        }
        payoutRewardSatang = allocation.rewardSatang;
        payoutFee = satang(
          Math.floor(feePoolSatang / underfilledConsents.length) +
          (underfilledConsents.findIndex(({ assignmentId }) => assignmentId === assignment.id) < feePoolSatang % underfilledConsents.length ? 1 : 0),
        );
        platformFeeValidation = 'QUEST_ESCROW_SNAPSHOT';
      }
    }
    payoutWorkers = [{ workerId: submission.workerId, amountSatang: payoutRewardSatang }];
    completedAssignmentIds = [assignment.id];
  }

  const paidSatang = await settleWorkers(
    tx,
    current.hirerId,
    reservation.id,
    payoutWorkers,
    () => Promise.resolve(payoutFee),
    `quest-v2-proof-approval:${proofSubmissionId}`,
    platformFeeValidation,
  );
  await tx
    .update(questAssignment)
    .set({ assignmentStatus: assignmentStatus.completed })
    .where(and(
      inArray(questAssignment.id, completedAssignmentIds),
      eq(questAssignment.assignmentStatus, assignmentStatus.active),
    ));

  let resultingQuestStatus = current.questStatus;
  if (current.questStatus === questStatus.inProgress) {
    const remainingWorkers = await activeAssignments(tx, questId);
    if (remainingWorkers.length === 0) {
      const remaining = (await reservationFor(tx, current.hirerId, questId, false))?.remainingSatang ?? 0;
      if (remaining !== 0) {
        throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'Quest Escrow does not match the completion payout.');
      }
      await tx
        .update(quest)
        .set({
          questStatus: questStatus.completed,
          version: sql`${quest.version} + 1`,
          updatedAt: now,
        })
        .where(and(eq(quest.id, questId), eq(quest.questStatus, questStatus.inProgress)));
      await terminalChat(tx, current, questStatus.completed, commandId, now, actorId);
      resultingQuestStatus = questStatus.completed;
    } else {
      const completedWorkers = workers.filter(({ id }) => completedAssignmentIds.includes(id));
      await inactiveWorkersChat(tx, current, completedWorkers, assignmentStatus.completed, now, actorId);
    }
  }

  return { questStatus: resultingQuestStatus, paidSatang, completedAssignmentIds };
};

export type QuestV2FailureEffect = {
  questStatus: 'QUEST_FAILED';
  incompleteAssignmentIds: string[];
};

/** Apply the terminal v2 failure transition without releasing held Quest Escrow. */
export const failQuestV2InTransaction = async (
  tx: QuestTransaction,
  questId: string,
  assignmentIds: string[],
  commandId: string,
  now: Date,
  actorId: string | null,
): Promise<QuestV2FailureEffect> => {
  const current = await lockQuest(tx, questId);
  if (!current || current.apiVersion !== 'v2') {
    throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'The Quest is not a v2 Quest.');
  }
  if (![questStatus.inProgress, questStatus.failed].includes(current.questStatus as never)) {
    throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'The v2 Quest cannot fail from its current state.');
  }

  const active = await activeAssignments(tx, questId);
  const activeById = new Map(active.map((assignment) => [assignment.id, assignment]));
  const affected = assignmentIds
    .map((assignmentId) => activeById.get(assignmentId))
    .filter((assignment): assignment is (typeof active)[number] => assignment !== undefined);
  if (current.questStatus === questStatus.inProgress && affected.length === 0) {
    throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'The failed Assignment is missing.');
  }

  if (affected.length > 0) {
    await tx
      .update(questAssignment)
      .set({ assignmentStatus: assignmentStatus.incomplete })
      .where(and(
        inArray(questAssignment.id, affected.map(({ id }) => id)),
        eq(questAssignment.assignmentStatus, assignmentStatus.active),
      ));
  }

  if (current.questStatus === questStatus.failed) {
    return {
      questStatus: questStatus.failed,
      incompleteAssignmentIds: affected.map(({ id }) => id),
    };
  }

  await inactiveWorkersChat(tx, current, affected, assignmentStatus.incomplete, now, actorId);
  await tx
    .update(quest)
    .set({
      questStatus: questStatus.failed,
      version: sql`${quest.version} + 1`,
      updatedAt: now,
    })
    .where(and(eq(quest.id, questId), eq(quest.questStatus, questStatus.inProgress)));
  await terminalChat(tx, current, questStatus.failed, commandId, now, actorId);
  return {
    questStatus: questStatus.failed,
    incompleteAssignmentIds: affected.map(({ id }) => id),
  };
};

export const completeQuest = async (questId: string, actorUserId: string, commandId = `quest-completion:${questId}`, now = new Date()) => db.transaction((tx) => completeInTransaction(tx, questId, actorUserId, commandId, now));

type LockedQuest = NonNullable<Awaited<ReturnType<typeof lockQuest>>>;
type ActiveWorker = Awaited<ReturnType<typeof activeAssignments>>[number];
type V2RewardAllocation = {
  assignmentId: string;
  workerId: string;
  rewardSatang: number;
  feeSatang: number;
};

const selectedV2TeamLeader = async (tx: QuestTransaction, questId: string) => {
  const [team] = await tx
    .select({ leaderId: questCandidateTeamV2.leaderId })
    .from(questCandidateTeamV2)
    .where(and(
      eq(questCandidateTeamV2.questId, questId),
      eq(questCandidateTeamV2.state, 'TEAM_SELECTED'),
    ))
    .limit(1)
    .for('update');
  return team?.leaderId ?? null;
};

const v2UnderfilledAllocations = async (
  tx: QuestTransaction,
  current: LockedQuest,
  expectedEscrowSatang: number,
): Promise<V2RewardAllocation[] | undefined> => {
  const [decision] = await tx
    .select({
      id: questV2UnderfilledDecision.id,
      state: questV2UnderfilledDecision.state,
      workerRewardPoolSatang: questV2UnderfilledDecision.workerRewardPoolSatang,
    })
    .from(questV2UnderfilledDecision)
    .where(eq(questV2UnderfilledDecision.questId, current.id))
    .limit(1)
    .for('update');
  if (!decision) return undefined;
  if (decision.state !== 'UNDERFILLED_COMPLETED') {
    throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'The underfilled Quest allocation is not complete.');
  }

  const consents = await tx
    .select({
      assignmentId: questV2UnderfilledConsent.assignmentId,
      workerId: questV2UnderfilledConsent.workerId,
      rewardSatang: questV2UnderfilledConsent.rewardSatang,
    })
    .from(questV2UnderfilledConsent)
    .where(and(
      eq(questV2UnderfilledConsent.decisionId, decision.id),
      eq(questV2UnderfilledConsent.decision, 'ACCEPT'),
    ))
    .orderBy(asc(questV2UnderfilledConsent.createdAt), asc(questV2UnderfilledConsent.id))
    .for('update');
  const assignments = await tx
    .select({
      id: questAssignment.id,
      workerId: questAssignment.workerId,
      assignmentStatus: questAssignment.assignmentStatus,
    })
    .from(questAssignment)
    .where(eq(questAssignment.questId, current.id));
  const eligibleAssignments = assignments.filter(({ assignmentStatus: status }) =>
    status === assignmentStatus.active || status === assignmentStatus.completed,
  );
  const rewardPoolSatang = current.rewardSatang === null
    ? 0
    : current.rewardSatang * current.headcount;
  const feePoolSatang = expectedEscrowSatang - rewardPoolSatang;
  const assignmentById = new Map(eligibleAssignments.map((assignment) => [assignment.id, assignment]));
  const allocationTotal = consents.reduce((total, consent) => total + consent.rewardSatang, 0);
  if (
    decision.workerRewardPoolSatang !== rewardPoolSatang ||
    consents.length === 0 ||
    consents.length > current.headcount ||
    eligibleAssignments.length !== consents.length ||
    feePoolSatang < 0 ||
    allocationTotal !== rewardPoolSatang ||
    consents.some((consent) => {
      const assignment = assignmentById.get(consent.assignmentId);
      return !assignment || assignment.workerId !== consent.workerId;
    })
  ) {
    throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'The underfilled Quest Escrow allocation is inconsistent.');
  }

  const baseFeeSatang = Math.floor(feePoolSatang / consents.length);
  const feeRemainderSatang = feePoolSatang % consents.length;
  return consents.map((consent, index) => ({
    assignmentId: consent.assignmentId,
    workerId: consent.workerId,
    rewardSatang: consent.rewardSatang,
    feeSatang: baseFeeSatang + (index < feeRemainderSatang ? 1 : 0),
  }));
};

const scaledCancellationAllocations = (
  allocations: Array<{ workerId: string; amountSatang: number }>,
  rewardPoolSatang: number,
) => {
  const total = Math.floor(rewardPoolSatang * 20 / 100);
  const payouts = allocations.map(({ workerId, amountSatang }) => ({
    workerId,
    amountSatang: Math.floor(amountSatang * 20 / 100),
  }));
  let remainder = total - payouts.reduce((sum, payout) => sum + payout.amountSatang, 0);
  for (const payout of payouts) {
    if (remainder <= 0) break;
    payout.amountSatang += 1;
    remainder -= 1;
  }
  return payouts.filter(({ amountSatang }) => amountSatang > 0);
};

const recordV2CancellationAudit = async (
  tx: QuestTransaction,
  current: LockedQuest,
  workers: ActiveWorker[],
  hirerId: string,
  now: Date,
) => {
  const actor: AuditActor = { actorType: 'MEMBER', actorUserId: hirerId };
  await recordAudit(tx, {
    ...actor,
    action: 'QUEST_STATE_CHANGED',
    resourceType: 'QUEST',
    resourceId: current.id,
    oldValue: { state: current.questStatus },
    newValue: { state: questStatus.cancelled },
    createdAt: now,
  });
  for (const worker of workers) {
    await recordAudit(tx, {
      ...actor,
      action: 'ASSIGNMENT_STATE_CHANGED',
      resourceType: 'ASSIGNMENT',
      resourceId: worker.id,
      oldValue: { state: assignmentStatus.active },
      newValue: { state: assignmentStatus.cancelled },
      createdAt: now,
    });
  }
};

const applyV2CancellationInTransaction = async (
  tx: QuestTransaction,
  current: LockedQuest,
  hirerId: string,
  commandId: string,
  now: Date,
): Promise<QuestSettlementOutcome> => {
  const discard = async (outcome: Extract<QuestSettlementOutcome, { outcome: string }>['outcome']) => {
    await tx.delete(questSettlementCommand).where(eq(questSettlementCommand.commandId, commandId));
    return { outcome } as QuestSettlementOutcome;
  };

  if (current.hirerId !== hirerId) return discard('not-authorized');
  if (
    current.questStatus === questStatus.assigned &&
    await hasPendingQuestV2EditRequest(tx, current.id)
  ) {
    return discard('invalid-state');
  }

  const cancelledByUserId = hirerId;
  if (current.questStatus === questStatus.draft) {
    await tx.update(quest).set({
      questStatus: questStatus.cancelled,
      cancelledAt: now,
      cancelledByUserId,
      cancelledByAdminId: null,
      version: sql`${quest.version} + 1`,
      updatedAt: now,
    }).where(and(
      eq(quest.id, current.id),
      eq(quest.questStatus, questStatus.draft),
      eq(quest.version, current.version),
    ));
    await recordV2CancellationAudit(tx, current, [], hirerId, now);
    await terminalChat(tx, current, questStatus.cancelled, commandId, now, hirerId);
    return {
      questStatus: questStatus.cancelled,
      outcome: 'CANCELLED',
      paidSatang: 0,
      refundedSatang: 0,
    };
  }

  if (![questStatus.open, questStatus.assigned, questStatus.inProgress].includes(current.questStatus as never)) {
    return discard('invalid-state');
  }

  const reservation = await reservationFor(tx, current.hirerId, current.id);
  if (
    !reservation ||
    reservation.status !== 'ACTIVE' ||
    (current.fundingReservationId !== null && current.fundingReservationId !== reservation.id)
  ) {
    return discard('invalid-state');
  }
  const rewardSatang = requireQuestReward(current.rewardSatang);
  const fee = await feeForQuest(tx, current, reservation, rewardSatang);
  const expectedEscrowSatang = current.questEscrowSatang ?? (rewardSatang + Number(fee)) * current.headcount;
  if (!Number.isSafeInteger(expectedEscrowSatang) || expectedEscrowSatang <= 0) {
    throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'Quest Escrow has invalid published terms.');
  }

  const workers = await activeAssignments(tx, current.id);
  const groupCandidate = current.v2Mode === 'CANDIDATE' && current.v2Participation === 'GROUP';
  const groupFcfs = current.v2Mode === 'FIRST_COME_FIRST_SERVED' && current.v2Participation === 'GROUP';
  let paidSatang = 0;
  let expectedRemainingSatang = expectedEscrowSatang;
  let payoutWorkers: Array<{ workerId: string; amountSatang: number }> = [];
  let payoutFee: (amountSatang: number, workerId?: string) => Promise<Satang | 0> = () => Promise.resolve(fee);
  let platformFeeValidation: 'POLICY' | 'QUEST_ESCROW_SNAPSHOT' = 'POLICY';

  if (current.questStatus === questStatus.assigned) {
    if (workers.length === 0) return discard('invalid-state');
    if (reservation.remainingSatang !== expectedEscrowSatang) {
      throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'Quest Escrow does not match the published funding terms.');
    }
    const rewardAllocations = groupFcfs
      ? await v2UnderfilledAllocations(tx, current, expectedEscrowSatang)
      : undefined;
    if (groupCandidate) {
      const leaderId = await selectedV2TeamLeader(tx, current.id);
      if (!leaderId || !workers.some(({ workerId }) => workerId === leaderId)) {
        throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'Selected Team Leader Assignment is missing.');
      }
      payoutWorkers = scaledCancellationAllocations(
        [{ workerId: leaderId, amountSatang: rewardSatang * current.headcount }],
        rewardSatang * current.headcount,
      );
    } else {
      const allocations = rewardAllocations
        ? rewardAllocations.map(({ workerId, rewardSatang: amountSatang }) => ({ workerId, amountSatang }))
        : workers.map(({ workerId }) => ({ workerId, amountSatang: rewardSatang }));
      if (
        allocations.length !== workers.length ||
        allocations.reduce((total, allocation) => total + allocation.amountSatang, 0) !== rewardSatang * current.headcount
      ) {
        return discard('invalid-state');
      }
      payoutWorkers = scaledCancellationAllocations(allocations, rewardSatang * current.headcount);
    }
    paidSatang = await settleWorkers(
      tx,
      current.hirerId,
      reservation.id,
      payoutWorkers,
      () => Promise.resolve(0),
      `quest-v2-cancel:${commandId}`,
    );
    expectedRemainingSatang -= paidSatang;
  } else if (current.questStatus === questStatus.inProgress) {
    if (workers.length === 0) return discard('invalid-state');
    if (groupCandidate) {
      const leaderId = await selectedV2TeamLeader(tx, current.id);
      if (!leaderId || !workers.some(({ workerId }) => workerId === leaderId)) {
        throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'Selected Team Leader Assignment is missing.');
      }
      payoutWorkers = Array.from({ length: current.headcount }, () => ({
        workerId: leaderId,
        amountSatang: rewardSatang,
      }));
      expectedRemainingSatang = (rewardSatang + Number(fee)) * current.headcount;
    } else {
      const underfilled = groupFcfs
        ? await v2UnderfilledAllocations(tx, current, expectedEscrowSatang)
        : undefined;
      const activeWorkerIds = new Set(workers.map(({ id }) => id));
      const allocations = underfilled
        ? underfilled.filter(({ assignmentId }) => activeWorkerIds.has(assignmentId))
        : workers.map(({ id, workerId }) => ({
            assignmentId: id,
            workerId,
            rewardSatang,
            feeSatang: Number(fee),
          }));
      if (allocations.length !== workers.length) return discard('invalid-state');
      payoutWorkers = allocations.map(({ workerId, rewardSatang: amountSatang }) => ({ workerId, amountSatang }));
      expectedRemainingSatang = allocations.reduce((total, allocation) => total + allocation.rewardSatang + allocation.feeSatang, 0);
      if (underfilled) {
        const feeByWorker = new Map(allocations.map(({ workerId, feeSatang }) => [workerId, feeSatang]));
        payoutFee = (_amountSatang, workerId) => Promise.resolve(satang(feeByWorker.get(workerId ?? '') ?? 0));
        platformFeeValidation = 'QUEST_ESCROW_SNAPSHOT';
      }
    }
    if (reservation.remainingSatang !== expectedRemainingSatang) {
      throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'Quest Escrow does not match the cancellation payout.');
    }
    paidSatang = await settleWorkers(
      tx,
      current.hirerId,
      reservation.id,
      payoutWorkers,
      payoutFee,
      `quest-v2-cancel:${commandId}`,
      platformFeeValidation,
    );
    const remainingAfterSettlement = (await reservationFor(tx, current.hirerId, current.id, false))?.remainingSatang;
    if (remainingAfterSettlement !== 0) {
      throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'Quest Escrow does not match the cancellation payout.');
    }
    expectedRemainingSatang = 0;
  }

  const beforeRelease = (await reservationFor(tx, current.hirerId, current.id, false))?.remainingSatang;
  if (beforeRelease !== expectedRemainingSatang) {
    throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'Quest Escrow does not match the cancellation payout.');
  }
  const refundedSatang = await releaseRemaining(
    tx,
    current.hirerId,
    reservation.id,
    `quest-v2-cancel-release:${commandId}`,
  );
  await tx.update(questAssignment).set({ assignmentStatus: assignmentStatus.cancelled }).where(and(
    eq(questAssignment.questId, current.id),
    eq(questAssignment.assignmentStatus, assignmentStatus.active),
  ));
  await inactiveWorkersChat(tx, current, workers, assignmentStatus.cancelled, now, hirerId);
  await tx.update(quest).set({
    questStatus: questStatus.cancelled,
    cancelledAt: now,
    cancelledByUserId,
    cancelledByAdminId: null,
    version: sql`${quest.version} + 1`,
    updatedAt: now,
  }).where(and(
    eq(quest.id, current.id),
    eq(quest.version, current.version),
  ));
  await recordV2CancellationAudit(tx, current, workers, hirerId, now);
  await terminalChat(tx, current, questStatus.cancelled, commandId, now, hirerId);
  return {
    questStatus: questStatus.cancelled,
    outcome: 'CANCELLED',
    paidSatang,
    refundedSatang,
  };
};

const settleV2CancellationInTransaction = async (
  tx: QuestTransaction,
  questId: string,
  hirerId: string,
  commandId: string,
  requestHash: string,
  now: Date,
): Promise<QuestSettlementOutcome> => {
  const current = await lockQuest(tx, questId);
  if (!current || current.apiVersion !== 'v2') return { outcome: 'not-found' };
  const command = await acquireCommand(tx, {
    commandId,
    questId,
    commandType: 'CANCEL',
    requestHash,
    actor: { userId: hirerId },
    now,
  });
  if ('outcome' in command) {
    if (command.outcome === 'idempotency-in-progress' || command.outcome === 'idempotency-unavailable') {
      return { outcome: 'idempotency-unavailable' };
    }
    return { outcome: command.outcome };
  }
  if ('replay' in command) return command.replay;

  const result = await applyV2CancellationInTransaction(tx, current, hirerId, commandId, now);
  if (!('questStatus' in result)) return result;
  await finishCommand(tx, commandId, result, now);
  return result;
};

export const cancelQuestV2 = async (
  hirerId: string,
  questId: string,
  rawCommandId: string,
  now = new Date(),
): Promise<QuestSettlementOutcome> => {
  const commandId = rawCommandId.trim();
  if (commandId.length === 0) return { outcome: 'idempotency-key-required' };
  if (commandId.length > 200) return { outcome: 'invalid-idempotency-key' };
  const requestHash = await hash({
    authenticatedMemberId: hirerId,
    operation: questV2CancellationOperationScope,
    path: questV2CancellationPath,
    questId,
    body: null,
  });
  return db.transaction((tx) => settleV2CancellationInTransaction(
    tx,
    questId,
    hirerId,
    commandId,
    requestHash,
    now,
  ));
};

/** A system cancellation authorises against the Hirer but attributes the cancellation to nobody. */
const cancelInTransaction = async (
  tx: QuestTransaction,
  questId: string,
  actor: Actor,
  commandId: string,
  now: Date,
  system = false,
): Promise<QuestSettlementOutcome> => {
  const current = await lockQuest(tx, questId);
  if (!current) return { outcome: 'not-found' };
  if (actor.userId && current.hirerId !== actor.userId) return { outcome: 'not-authorized' };
  if (!actor.userId && !actor.adminId) return { outcome: 'not-authorized' };
  const cancelledByUserId = system ? null : actor.userId ?? null;
  const cancelledByAdminId = actor.adminId ?? null;
  const chatActorId = cancelledByUserId ?? cancelledByAdminId;
  if (
    current.apiVersion === 'v2' &&
    current.questStatus === questStatus.assigned &&
    await hasPendingQuestV2EditRequest(tx, questId)
  ) {
    return { outcome: 'invalid-state' };
  }
  if (current.questStatus === questStatus.draft) {
    await tx.update(quest).set({
      questStatus: questStatus.cancelled,
      cancelledAt: now,
      cancelledByUserId,
      cancelledByAdminId,
      version: sql`${quest.version} + 1`,
      updatedAt: now,
    }).where(and(
      eq(quest.id, questId),
      eq(quest.questStatus, questStatus.draft),
      eq(quest.version, current.version),
    ));
    return { questStatus: questStatus.cancelled, outcome: 'CANCELLED', paidSatang: 0, refundedSatang: 0 };
  }
  if (![questStatus.open, questStatus.assigned, questStatus.inProgress].includes(current.questStatus as never)) return { outcome: 'invalid-state' };
  const reservation = await reservationFor(tx, current.hirerId, questId);
  if (!reservation || reservation.status !== 'ACTIVE') return { outcome: 'invalid-state' };
  const workers = await activeAssignments(tx, questId);
  const rewardSatang = requireQuestReward(current.rewardSatang);
  const groupCandidate = current.mode === 'CANDIDATE' && current.participation === 'GROUP';
  const requiresTeamLeader = groupCandidate && current.questStatus !== questStatus.open;
  const leaderId = requiresTeamLeader ? await selectedTeamLeader(tx, questId) : null;
  if (requiresTeamLeader && (!leaderId || !workers.some(({ workerId }) => workerId === leaderId))) {
    throw new MoneyDomainError('FUNDING_SETTLEMENT_FAILED', 'Selected Team Leader Assignment is missing.');
  }
  let paid = 0;
  // Past QUEST_OPEN a non-null `leaderId` means the Quest is GROUP + CANDIDATE, so it is
  // both the payee and the discriminator for the Team Leader payout rules.
  if (current.questStatus === questStatus.assigned) {
    const pool = rewardSatang * current.headcount;
    const twentyPercent = Math.floor(pool * 20 / 100);
    const base = leaderId ? 0 : (workers.length > 0 ? Math.floor(twentyPercent / workers.length) : 0);
    const remainder = leaderId ? 0 : (workers.length > 0 ? twentyPercent % workers.length : 0);
    paid = await settleWorkers(
      tx,
      current.hirerId,
      reservation.id,
      (leaderId
        ? [{ workerId: leaderId, amountSatang: twentyPercent }]
        : workers.map(({ workerId }, index) => ({ workerId, amountSatang: base + (index < remainder ? 1 : 0) }))
      ).filter(({ amountSatang }) => amountSatang > 0),
      () => Promise.resolve(0),
      `quest-cancel:${commandId}`,
    );
  } else if (current.questStatus === questStatus.inProgress) {
    const fee = await feeForQuest(tx, current, reservation, rewardSatang);
    const payoutWorkers = leaderId
      ? Array.from({ length: current.headcount }, () => ({ workerId: leaderId, amountSatang: rewardSatang }))
      : workers.map(({ workerId }) => ({ workerId, amountSatang: rewardSatang }));
    paid = await settleWorkers(
      tx,
      current.hirerId,
      reservation.id,
      payoutWorkers,
      () => Promise.resolve(fee),
      `quest-cancel:${commandId}`,
    );
  }
  const beforeRelease = (await reservationFor(tx, current.hirerId, questId, false))?.remainingSatang ?? 0;
  const releasedAmount = await releaseRemaining(tx, current.hirerId, reservation.id, `quest-cancel-release:${commandId}`);
  await tx.update(questAssignment).set({ assignmentStatus: assignmentStatus.cancelled }).where(and(
    eq(questAssignment.questId, questId),
    eq(questAssignment.assignmentStatus, assignmentStatus.active),
  ));
  await inactiveWorkersChat(tx, current, workers, assignmentStatus.cancelled, now, chatActorId);
  await tx.update(quest).set({
    questStatus: questStatus.cancelled,
    cancelledAt: now,
    cancelledByUserId,
    cancelledByAdminId,
    version: sql`${quest.version} + 1`,
    updatedAt: now,
  }).where(and(
    eq(quest.id, questId),
    eq(quest.version, current.version),
  ));
  await terminalChat(tx, current, questStatus.cancelled, commandId, now, chatActorId);
  return { questStatus: questStatus.cancelled, outcome: 'CANCELLED', paidSatang: paid, refundedSatang: beforeRelease || releasedAmount };
};

export const terminateQuestInTransaction = (
  tx: QuestTransaction,
  questId: string,
  adminId: string,
  commandId: string,
  now = new Date(),
) => cancelInTransaction(tx, questId, { adminId }, commandId, now);

const settleCancellationInTransaction = async (
  tx: QuestTransaction,
  questId: string,
  hirerId: string,
  commandId: string,
  now: Date,
  system = false,
): Promise<QuestSettlementOutcome> => {
  const command = await acquireCommand(tx, {
    commandId,
    questId,
    commandType: system ? 'AUTO_CANCEL' : 'CANCEL',
    requestHash: await hash(system ? { command: 'auto-cancel', questId } : { command: 'cancel', questId, hirerId }),
    actor: system ? {} : { userId: hirerId },
    now,
  });
  if ('outcome' in command) {
    if (command.outcome === 'idempotency-in-progress' || command.outcome === 'idempotency-unavailable') {
      return { outcome: 'idempotency-unavailable' };
    }
    return { outcome: command.outcome };
  }
  if ('replay' in command) return command.replay;

  const result = await cancelInTransaction(tx, questId, { userId: hirerId }, commandId, now, system);
  if (!('questStatus' in result)) {
    await tx.delete(questSettlementCommand).where(eq(questSettlementCommand.commandId, commandId));
    return result;
  }
  await finishCommand(tx, commandId, result, now);
  return result;
};

export const cancelQuest = async (hirerId: string, questId: string, commandId: string, now = new Date()) => {
  if (!commandId.trim()) return { outcome: 'idempotency-key-required' as const };
  return db.transaction((tx) => settleCancellationInTransaction(tx, questId, hirerId, commandId, now));
};

/** Settle an underfilled cancellation in the caller's Quest transaction. */
export const settleUnderfilledCancellationInTransaction = (
  tx: QuestTransaction,
  questId: string,
  hirerId: string,
  commandId: string,
  now: Date,
  system = false,
) => settleCancellationInTransaction(tx, questId, hirerId, commandId, now, system);

export type AutomaticQuestCancellationOutcome =
  | (CommandResult & { replayed?: boolean })
  | { outcome: 'not-due' | 'idempotency-key-reused' | 'idempotency-unavailable' };

const autoCancelInTransaction = async (
  tx: QuestTransaction,
  questId: string,
  commandId: string,
  now: Date,
): Promise<AutomaticQuestCancellationOutcome> => {
  const current = await lockQuest(tx, questId);
  if (!current) return { outcome: 'not-due' };

  const command = await acquireCommand(tx, {
    commandId,
    questId,
    commandType: 'AUTO_CANCEL',
    requestHash: await hash({ command: 'auto-cancel', questId }),
    actor: {},
    now,
  });
  if ('outcome' in command) {
    return command.outcome === 'idempotency-in-progress' || command.outcome === 'idempotency-unavailable'
      ? { outcome: 'not-due' }
      : { outcome: command.outcome };
  }
  if ('replay' in command) return { ...command.replay, replayed: true };

  if (current.questStatus !== questStatus.open || current.startTime > now) {
    await tx.delete(questSettlementCommand).where(eq(questSettlementCommand.commandId, commandId));
    return { outcome: 'not-due' };
  }

  const reservation = await reservationFor(tx, current.hirerId, questId);
  if (!reservation || reservation.status !== 'ACTIVE') {
    await tx.delete(questSettlementCommand).where(eq(questSettlementCommand.commandId, commandId));
    return { outcome: 'not-due' };
  }

  const workers = await activeAssignments(tx, questId);
  const refunded = await releaseRemaining(tx, current.hirerId, reservation.id, `quest-auto-cancel-release:${questId}`);
  await tx.update(questAssignment)
    .set({ assignmentStatus: assignmentStatus.cancelled })
    .where(and(
      eq(questAssignment.questId, questId),
      eq(questAssignment.assignmentStatus, assignmentStatus.active),
    ));
  await inactiveWorkersChat(tx, current, workers, assignmentStatus.cancelled, now, null);
  await tx.update(quest).set({
    questStatus: questStatus.cancelled,
    cancelledAt: now,
    cancelledByUserId: null,
    cancelledByAdminId: null,
    version: sql`${quest.version} + 1`,
    updatedAt: now,
  }).where(and(eq(quest.id, questId), eq(quest.questStatus, questStatus.open)));
  await terminalChat(tx, current, questStatus.cancelled, commandId, now, null);
  const result: CommandResult = {
    questStatus: questStatus.cancelled,
    outcome: 'CANCELLED',
    paidSatang: 0,
    refundedSatang: refunded,
  };
  await finishCommand(tx, commandId, result, now);
  return result;
};

/** Cancel one due OPEN Quest without attributing the system action to a Member or Admin. */
export const cancelUnfilledQuest = async (
  questId: string,
  now = new Date(),
): Promise<AutomaticQuestCancellationOutcome> => db.transaction((tx) => autoCancelInTransaction(
  tx,
  questId,
  `quest-auto-cancel:${questId}`,
  now,
));

export const resolveQuestDispute = async (adminId: string, questId: string, commandId: string, outcome: 'REFUND_HIRER' | 'RELEASE_TO_WORKER', allocations: Allocation[] = [], now = new Date()) => {
  if (!commandId.trim()) return { outcome: 'idempotency-key-required' as const };
  const normalized = allocations.map(({ workerId, amountSatang }) => ({ workerId, amountSatang }));
  const requestHash = await hash({ command: outcome, questId, allocations: normalized });
  return db.transaction(async (tx) => {
    const command = await acquireCommand(tx, { commandId, questId, commandType: outcome === 'REFUND_HIRER' ? 'DISPUTE_REFUND' : 'DISPUTE_RELEASE', requestHash, actor: { adminId }, now });
    if ('outcome' in command) return command.outcome === 'idempotency-in-progress' ? { outcome: 'idempotency-unavailable' as const } : command;
    if ('replay' in command) return command.replay;
    const current = await lockQuest(tx, questId);
    if (!current) { await tx.delete(questSettlementCommand).where(eq(questSettlementCommand.commandId, commandId)); return { outcome: 'not-found' as const }; }
    if (current.questStatus !== questStatus.disputed) { await tx.delete(questSettlementCommand).where(eq(questSettlementCommand.commandId, commandId)); return { outcome: 'invalid-state' as const }; }
    const reservation = await reservationFor(tx, current.hirerId, questId);
    if (!reservation || reservation.status !== 'ACTIVE') { await tx.delete(questSettlementCommand).where(eq(questSettlementCommand.commandId, commandId)); return { outcome: 'invalid-state' as const }; }
    const workers = await activeAssignments(tx, questId);
    let paid = 0;
    if (outcome === 'RELEASE_TO_WORKER') {
      const workerIds = new Set(workers.map(({ workerId }) => workerId));
      if (normalized.length === 0 || normalized.some(({ workerId, amountSatang }) => !workerIds.has(workerId) || !Number.isSafeInteger(amountSatang) || amountSatang <= 0) || new Set(normalized.map(({ workerId }) => workerId)).size !== normalized.length) {
        await tx.delete(questSettlementCommand).where(eq(questSettlementCommand.commandId, commandId));
        return { outcome: 'allocations-invalid' as const };
      }
      const remaining = reservation.remainingSatang;
      const allocationTotal = normalized.reduce((sum, allocation) => sum + allocation.amountSatang, 0);
      if (!Number.isSafeInteger(allocationTotal) || allocationTotal > remaining) {
        await tx.delete(questSettlementCommand).where(eq(questSettlementCommand.commandId, commandId));
        return { outcome: 'allocations-invalid' as const };
      }
      paid = await settleWorkers(tx, current.hirerId, reservation.id, normalized, () => Promise.resolve(0), `quest-dispute:${commandId}`);
      await releaseRemaining(tx, current.hirerId, reservation.id, `quest-dispute-refund:${commandId}`);
      const awarded = new Set(normalized.map(({ workerId }) => workerId));
      const incompleteWorkers = workers.filter(({ workerId }) => !awarded.has(workerId));
      await tx.update(questAssignment).set({ assignmentStatus: assignmentStatus.completed }).where(and(eq(questAssignment.questId, questId), eq(questAssignment.assignmentStatus, assignmentStatus.active), inArray(questAssignment.workerId, [...awarded])));
      await tx.update(questAssignment).set({ assignmentStatus: assignmentStatus.incomplete }).where(and(eq(questAssignment.questId, questId), eq(questAssignment.assignmentStatus, assignmentStatus.active)));
      await inactiveWorkersChat(tx, current, incompleteWorkers, assignmentStatus.incomplete, now, adminId);
      await tx.update(quest).set({ questStatus: questStatus.completed, version: sql`${quest.version} + 1`, updatedAt: now }).where(eq(quest.id, questId));
      await terminalChat(tx, current, questStatus.completed, commandId, now);
      const result: CommandResult = { questStatus: questStatus.completed, outcome: 'RELEASED_TO_WORKER', paidSatang: paid, refundedSatang: remaining - paid };
      await finishCommand(tx, commandId, result, now);
      return result;
    }
    const refunded = await releaseRemaining(tx, current.hirerId, reservation.id, `quest-dispute-refund:${commandId}`);
    await tx.update(questAssignment).set({ assignmentStatus: assignmentStatus.cancelled }).where(and(eq(questAssignment.questId, questId), eq(questAssignment.assignmentStatus, assignmentStatus.active)));
    await inactiveWorkersChat(tx, current, workers, assignmentStatus.cancelled, now, adminId);
    await tx.update(quest).set({ questStatus: questStatus.cancelled, cancelledAt: now, cancelledByAdminId: adminId, version: sql`${quest.version} + 1`, updatedAt: now }).where(eq(quest.id, questId));
    await terminalChat(tx, current, questStatus.cancelled, commandId, now);
    const result: CommandResult = { questStatus: questStatus.cancelled, outcome: 'REFUNDED', paidSatang: 0, refundedSatang: refunded };
    await finishCommand(tx, commandId, result, now);
    return result;
  });
};
