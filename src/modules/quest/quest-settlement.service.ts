import { db } from '@/database/client';
import {
  paymentMoneyPolicyRevision,
  walletFundingReservation,
} from '@/database/schema/wallet.schema';
import {
  quest,
  questAssignment,
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
  | { outcome: 'not-found' | 'not-authorized' | 'invalid-state' | 'idempotency-key-reused' | 'idempotency-key-required' | 'idempotency-unavailable' | 'allocations-invalid' }
  | { questStatus: QuestStatus; outcome: 'COMPLETED' | 'CANCELLED' | 'REFUNDED' | 'RELEASED_TO_WORKER'; paidSatang: number; refundedSatang: number };

type Actor = { userId?: string; adminId?: string };
type CommandType = 'COMPLETE' | 'CANCEL' | 'AUTO_CANCEL' | 'DISPUTE_REFUND' | 'DISPUTE_RELEASE';
type Allocation = { workerId: string; amountSatang: number };
type CommandResult = Extract<QuestSettlementOutcome, { questStatus: QuestStatus }>;

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
  version: quest.version,
  rewardSatang: quest.rewardSatang,
  platformFeePerWorkerSatang: quest.platformFeePerWorkerSatang,
  questEscrowSatang: quest.questEscrowSatang,
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
  status: 'QUEST_COMPLETED' | 'QUEST_CANCELLED',
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

const settleWorkers = async (tx: QuestTransaction, ownerUserId: string, reservationId: string, workers: { workerId: string; amountSatang: number }[], feeFor: (amount: number) => Promise<Satang | 0>, reference: string) => {
  let paid = 0;
  for (const [index, worker] of workers.entries()) {
    const amount = positiveSatang(worker.amountSatang);
    const fee = await feeFor(worker.amountSatang);
    await settleFundingReservation(tx, {
      ownerUserId,
      reservationId,
      settlementReference: `${reference}:${index}:${worker.workerId}`,
      recipientUserId: worker.workerId,
      recipientAmountSatang: amount,
      platformFeeSatang: fee || undefined,
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

export const completeQuest = async (questId: string, actorUserId: string, commandId = `quest-completion:${questId}`, now = new Date()) => db.transaction((tx) => completeInTransaction(tx, questId, actorUserId, commandId, now));

type CancellationActor = Actor;

/** A system cancellation authorises against the Hirer but attributes the cancellation to nobody. */
const cancelInTransaction = async (
  tx: QuestTransaction,
  questId: string,
  actor: CancellationActor,
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
  if (current.questStatus === questStatus.assigned) {
    const pool = rewardSatang * current.headcount;
    const twentyPercent = Math.floor(pool * 20 / 100);
    if (groupCandidate) {
      if (twentyPercent > 0) {
        paid = await settleWorkers(
          tx,
          current.hirerId,
          reservation.id,
          [{ workerId: leaderId!, amountSatang: twentyPercent }],
          () => Promise.resolve(0),
          `quest-cancel:${commandId}`,
        );
      }
    } else {
      const base = workers.length > 0 ? Math.floor(twentyPercent / workers.length) : 0;
      const remainder = workers.length > 0 ? twentyPercent % workers.length : 0;
      paid = await settleWorkers(
        tx,
        current.hirerId,
        reservation.id,
        workers
          .map(({ workerId }, index) => ({ workerId, amountSatang: base + (index < remainder ? 1 : 0) }))
          .filter(({ amountSatang }) => amountSatang > 0),
        () => Promise.resolve(0),
        `quest-cancel:${commandId}`,
      );
    }
  } else if (current.questStatus === questStatus.inProgress) {
    const fee = await feeForQuest(tx, current, reservation, rewardSatang);
    const payoutWorkers = groupCandidate
      ? Array.from({ length: current.headcount }, () => ({ workerId: leaderId!, amountSatang: rewardSatang }))
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
