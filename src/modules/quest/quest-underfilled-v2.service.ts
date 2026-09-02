import { db } from '@/database/client';
import {
  quest,
  questApiVersion,
  questAssignment,
  questV2UnderfilledConsent,
  questV2UnderfilledDecision,
} from '@/database/schema/quest.schema';
import { walletIdempotencyKey } from '@/database/schema/wallet.schema';
import { satang, toBaht } from '@/modules/wallet';

import { and, asc, eq, isNull, lte, or } from 'drizzle-orm';

import { settleUnderfilledCancellationInTransaction } from './quest-settlement.service';
import type { QuestTransaction } from './quest-work-chat.port';
import {
  formatQuestV2ScheduleTime,
  questV2Mode,
  questV2Participation,
  questV2States,
  questV2UnderfilledConsentDecisions,
  questV2UnderfilledDecisionValues,
  questV2UnderfilledStates,
  type QuestV2State,
  type QuestV2UnderfilledConsentDecision,
  type QuestV2UnderfilledDecision,
  type QuestV2UnderfilledResolutionCode,
  type QuestV2UnderfilledState,
} from './quest-v2.contract';
import type {
  QuestV2UnderfilledConsentInput,
  QuestV2UnderfilledData,
  QuestV2UnderfilledDecisionInput,
} from './quest-underfilled-v2.schema';

export const questV2UnderfilledDecisionOperationScope = 'quest.v2.underfilled.decision';
export const questV2UnderfilledConsentOperationScope = 'quest.v2.underfilled.consent';

const WINDOW_MILLISECONDS = 10 * 60 * 1_000;

type QuestRow = {
  id: string;
  hirerId: string;
  apiVersion: string;
  v2Mode: string | null;
  v2Participation: string | null;
  questState: string;
  headcount: number;
  rewardSatang: number | null;
  startTime: Date;
  dueAt: Date | null;
};

type DecisionRow = typeof questV2UnderfilledDecision.$inferSelect;
type ConsentRow = typeof questV2UnderfilledConsent.$inferSelect;

type BusinessOutcomeCode =
  | 'not-found'
  | 'not-authorized'
  | 'not-underfilled'
  | 'not-pending'
  | 'already-responded'
  | 'expired'
  | 'invalid-funding';
type IdempotencyOutcomeCode =
  | 'invalid-idempotency-key'
  | 'idempotency-key-reused'
  | 'idempotency-in-progress'
  | 'idempotency-unavailable';
type OutcomeCode = BusinessOutcomeCode | IdempotencyOutcomeCode;

export type QuestV2UnderfilledOutcome =
  | { underfilled: QuestV2UnderfilledData }
  | { outcome: OutcomeCode };

type IdempotencyRecord = {
  id: string;
  requestHash: string;
  resourceId: string | null;
  resultData: unknown;
  processingStatus: string;
};

type IdempotencyResult =
  | { created: true; record: IdempotencyRecord }
  | { created: false; record: IdempotencyRecord }
  | { outcome: Exclude<IdempotencyOutcomeCode, 'invalid-idempotency-key'> };

export type QuestV2UnderfilledDetectionResult = {
  underfilled: boolean;
  created: boolean;
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
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const idempotencyExpiry = (now: Date) => new Date(now.getTime() + 24 * 60 * 60 * 1_000);

const isUnderfilledState = (value: unknown): value is QuestV2UnderfilledState =>
  typeof value === 'string' && (questV2UnderfilledStates as readonly string[]).includes(value);

const isQuestV2State = (value: unknown): value is QuestV2State =>
  typeof value === 'string' && (questV2States as readonly string[]).includes(value);

const isDecision = (value: unknown): value is QuestV2UnderfilledDecision =>
  typeof value === 'string' && (questV2UnderfilledDecisionValues as readonly string[]).includes(value);

const isConsentDecision = (value: unknown): value is QuestV2UnderfilledConsentDecision =>
  typeof value === 'string' && (questV2UnderfilledConsentDecisions as readonly string[]).includes(value);

const isPendingProtocolState = (value: string) =>
  value === 'UNDERFILLED_DECISION_PENDING' || value === 'UNDERFILLED_CONSENT_PENDING';

const isData = (value: unknown): value is QuestV2UnderfilledData => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Partial<QuestV2UnderfilledData>;
  return (
    typeof data.id === 'string' &&
    typeof data.questId === 'string' &&
    isQuestV2State(data.questState) &&
    isUnderfilledState(data.state) &&
    Number.isInteger(data.activeWorkerCount) &&
    Number.isInteger(data.headcount) &&
    (data.workerRewardPool === null || typeof data.workerRewardPool === 'number') &&
    (data.questReward === null || typeof data.questReward === 'number') &&
    (typeof data.dueAt === 'string' || data.dueAt === null)
  );
};

const requestHashFor = (
  userId: string,
  questId: string,
  operation: string,
  path: string,
  decision: string,
): Promise<string> => sha256Json({
  authenticatedMemberId: userId,
  operation,
  path,
  questId,
  body: { decision },
});

const acquireIdempotency = async (
  transaction: QuestTransaction,
  userId: string,
  operationScope: string,
  key: string,
  requestHash: string,
  now: Date,
): Promise<IdempotencyResult> => {
  const [created] = await transaction
    .insert(walletIdempotencyKey)
    .values({
      principalUserId: userId,
      operationScope,
      key,
      requestHash,
      expiresAt: idempotencyExpiry(now),
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
  if (existing.processingStatus === 'PROCESSING') return { outcome: 'idempotency-in-progress' };
  return { outcome: 'idempotency-unavailable' };
};

const lockQuest = async (transaction: QuestTransaction, questId: string): Promise<QuestRow | undefined> => {
  const [current] = await transaction
    .select({
      id: quest.id,
      hirerId: quest.hirerId,
      apiVersion: quest.apiVersion,
      v2Mode: quest.v2Mode,
      v2Participation: quest.v2Participation,
      questState: quest.questStatus,
      headcount: quest.headcount,
      rewardSatang: quest.rewardSatang,
      startTime: quest.startTime,
      dueAt: quest.dueAt,
    })
    .from(quest)
    .where(and(eq(quest.id, questId), eq(quest.apiVersion, questApiVersion.v2)))
    .limit(1)
    .for('update');
  return current;
};

const selectDecision = async (
  transaction: QuestTransaction,
  questId: string,
  lock = false,
): Promise<DecisionRow | undefined> => {
  const query = transaction
    .select()
    .from(questV2UnderfilledDecision)
    .where(eq(questV2UnderfilledDecision.questId, questId))
    .limit(1);
  const rows = await (lock ? query.for('update') : query);
  return rows[0];
};

const selectConsents = async (
  transaction: QuestTransaction,
  decisionId: string,
  lock = false,
): Promise<ConsentRow[]> => {
  const query = transaction
    .select()
    .from(questV2UnderfilledConsent)
    .where(eq(questV2UnderfilledConsent.decisionId, decisionId))
    .orderBy(asc(questV2UnderfilledConsent.createdAt), asc(questV2UnderfilledConsent.id));
  return lock ? query.for('update') : query;
};

const activeAssignments = async (transaction: QuestTransaction, questId: string) => transaction
  .select({
    id: questAssignment.id,
    workerId: questAssignment.workerId,
    createdAt: questAssignment.createdAt,
  })
  .from(questAssignment)
  .where(and(
    eq(questAssignment.questId, questId),
    eq(questAssignment.assignmentStatus, 'ASSIGNMENT_ACTIVE'),
  ))
  .orderBy(asc(questAssignment.createdAt), asc(questAssignment.id))
  .for('update');

const hasActiveAssignment = async (
  transaction: QuestTransaction,
  questId: string,
  workerId: string,
) => {
  const [assignment] = await transaction
    .select({ id: questAssignment.id })
    .from(questAssignment)
    .where(and(
      eq(questAssignment.questId, questId),
      eq(questAssignment.workerId, workerId),
      eq(questAssignment.assignmentStatus, 'ASSIGNMENT_ACTIVE'),
    ))
    .limit(1)
    .for('update');
  return Boolean(assignment);
};

const isDueUnderfilledQuest = (current: QuestRow, now: Date) =>
  current.apiVersion === questApiVersion.v2 &&
  current.v2Mode === questV2Mode.firstComeFirstServed &&
  current.v2Participation === questV2Participation.group &&
  current.questState === 'QUEST_OPEN' &&
  current.startTime.getTime() <= now.getTime();

const createDecisionInTransaction = async (
  transaction: QuestTransaction,
  current: QuestRow,
  now: Date,
): Promise<QuestV2UnderfilledDetectionResult> => {
  const existing = await selectDecision(transaction, current.id, true);
  if (existing) return { underfilled: true, created: false };
  if (!isDueUnderfilledQuest(current, now)) return { underfilled: false, created: false };

  const assignments = await activeAssignments(transaction, current.id);
  if (assignments.length === 0 || assignments.length >= current.headcount) {
    return { underfilled: false, created: false };
  }
  if (current.rewardSatang === null) {
    throw new Error(`Quest ${current.id} has no Worker Reward for underfilled allocation`);
  }
  const workerRewardPoolSatang = current.rewardSatang * current.headcount;
  if (!Number.isSafeInteger(workerRewardPoolSatang) || workerRewardPoolSatang <= 0) {
    throw new Error(`Quest ${current.id} has an invalid Worker Reward pool`);
  }
  const baseRewardSatang = Math.floor(workerRewardPoolSatang / assignments.length);
  const remainderSatang = workerRewardPoolSatang % assignments.length;
  const [created] = await transaction
    .insert(questV2UnderfilledDecision)
    .values({
      questId: current.id,
      activeWorkerCount: assignments.length,
      workerRewardPoolSatang,
      state: 'UNDERFILLED_DECISION_PENDING',
      decisionExpiresAt: new Date(current.startTime.getTime() + WINDOW_MILLISECONDS),
      detectedAt: current.startTime,
    })
    .returning();
  if (!created) return { underfilled: false, created: false };

  await transaction.insert(questV2UnderfilledConsent).values(assignments.map((assignment, index) => ({
    decisionId: created.id,
    questId: current.id,
    assignmentId: assignment.id,
    workerId: assignment.workerId,
    rewardSatang: baseRewardSatang + (index < remainderSatang ? 1 : 0),
    createdAt: assignment.createdAt,
  })));
  return { underfilled: true, created: true };
};

const completeIdempotency = async (
  transaction: QuestTransaction,
  idempotencyId: string,
  resourceId: string,
  data: QuestV2UnderfilledData,
  now: Date,
) => {
  await transaction
    .update(walletIdempotencyKey)
    .set({
      resourceType: 'quest-v2-underfilled',
      resourceId,
      resultData: { underfilled: data },
      processingStatus: 'COMPLETED',
      completedAt: now,
    })
    .where(eq(walletIdempotencyKey.id, idempotencyId));
};

const replayOrOutcome = (idempotency: IdempotencyResult): QuestV2UnderfilledOutcome | undefined => {
  if ('outcome' in idempotency) return { outcome: idempotency.outcome };
  if (idempotency.created) return undefined;
  if (!idempotency.record.resultData || typeof idempotency.record.resultData !== 'object') {
    return { outcome: 'idempotency-unavailable' };
  }
  const result = idempotency.record.resultData as { underfilled?: unknown };
  return isData(result.underfilled)
    ? { underfilled: result.underfilled }
    : { outcome: 'idempotency-unavailable' };
};

const decisionStatusFor = (decision: DecisionRow) => {
  if (decision.state === 'UNDERFILLED_DECISION_PENDING') return 'UNDERFILLED_DECISION_PENDING' as const;
  if (decision.state === 'UNDERFILLED_CANCELLED') return 'UNDERFILLED_DECISION_CANCELLED' as const;
  return 'UNDERFILLED_DECISION_PROCEEDED' as const;
};

const consentStatusFor = (decision: DecisionRow) => {
  if (decision.state === 'UNDERFILLED_DECISION_PENDING') return 'UNDERFILLED_CONSENT_NOT_STARTED' as const;
  if (decision.state === 'UNDERFILLED_CONSENT_PENDING') return 'UNDERFILLED_CONSENT_PENDING' as const;
  if (decision.state === 'UNDERFILLED_COMPLETED') return 'UNDERFILLED_CONSENT_COMPLETED' as const;
  return 'UNDERFILLED_CONSENT_CANCELLED' as const;
};

const project = async (
  transaction: QuestTransaction,
  memberId: string,
  current: QuestRow,
  decision: DecisionRow,
): Promise<QuestV2UnderfilledData | undefined> => {
  if (!isQuestV2State(current.questState)) {
    throw new Error(`Quest ${current.id} has an invalid V2 State`);
  }
  const consents = await selectConsents(transaction, decision.id);
  const ownResponse = consents.find((consent) => consent.workerId === memberId);
  const isHirer = current.hirerId === memberId;
  if (!isHirer && !ownResponse) return undefined;

  const acceptedCount = consents.filter((consent) => consent.decision === 'ACCEPT').length;
  const declinedCount = consents.filter((consent) => consent.decision === 'DECLINE').length;
  const data: QuestV2UnderfilledData = {
    id: decision.id,
    questId: decision.questId,
    questState: current.questState,
    state: decision.state,
    activeWorkerCount: decision.activeWorkerCount,
    headcount: current.headcount,
    workerRewardPool: isHirer ? toBaht(satang(decision.workerRewardPoolSatang)) : null,
    questReward: ownResponse ? toBaht(satang(ownResponse.rewardSatang)) : null,
    dueAt: current.dueAt ? formatQuestV2ScheduleTime(current.dueAt) : null,
    decision: {
      status: decisionStatusFor(decision),
      value: decision.decision,
      expiresAt: decision.decisionExpiresAt.toISOString(),
    },
    consent: {
      status: consentStatusFor(decision),
      expiresAt: decision.consentExpiresAt?.toISOString() ?? null,
      totalCount: consents.length,
      acceptedCount,
      declinedCount,
      pendingCount: consents.length - acceptedCount - declinedCount,
    },
  };

  if (isHirer) {
    data.responses = consents.map((consent) => ({
      workerId: consent.workerId,
      assignmentId: consent.assignmentId,
      decision: consent.decision,
      questReward: toBaht(satang(consent.rewardSatang)),
      respondedAt: consent.respondedAt?.toISOString() ?? null,
    }));
  } else {
    data.ownResponse = {
      decision: ownResponse?.decision ?? null,
      questReward: toBaht(satang(ownResponse?.rewardSatang ?? 0)),
      respondedAt: ownResponse?.respondedAt?.toISOString() ?? null,
    };
  }
  return data;
};

const cancelUnderfilledInTransaction = async (
  transaction: QuestTransaction,
  current: QuestRow,
  decision: DecisionRow,
  resolutionCode: QuestV2UnderfilledResolutionCode,
  now: Date,
): Promise<{ current: QuestRow; decision: DecisionRow }> => {
  if (current.questState !== 'QUEST_OPEN') {
    const [updated] = await transaction
      .update(questV2UnderfilledDecision)
      .set({
        state: 'UNDERFILLED_CANCELLED',
        decision: resolutionCode === 'HIRER_CANCELLED' ? 'CANCEL' : decision.decision,
        consentExpiresAt: null,
        resolutionCode,
        resolvedAt: now,
      })
      .where(eq(questV2UnderfilledDecision.id, decision.id))
      .returning();
    return { current, decision: updated ?? decision };
  }

  const systemCancellation = resolutionCode !== 'HIRER_CANCELLED';
  const settlement = await settleUnderfilledCancellationInTransaction(
    transaction,
    current.id,
    current.hirerId,
    `quest-underfilled-cancel:${decision.id}:${resolutionCode}`,
    now,
    systemCancellation,
  );
  if (!('questStatus' in settlement)) {
    throw new Error(`Quest ${current.id} could not be cancelled for underfilled resolution`);
  }
  const [updated] = await transaction
    .update(questV2UnderfilledDecision)
    .set({
      state: 'UNDERFILLED_CANCELLED',
      decision: resolutionCode === 'HIRER_CANCELLED' ? 'CANCEL' : decision.decision,
      consentExpiresAt: null,
      resolutionCode,
      resolvedAt: now,
    })
    .where(eq(questV2UnderfilledDecision.id, decision.id))
    .returning();
  return {
    current: { ...current, questState: settlement.questStatus },
    decision: updated ?? decision,
  };
};

const expireInTransaction = async (
  transaction: QuestTransaction,
  current: QuestRow,
  decision: DecisionRow,
  now: Date,
): Promise<{ expired: boolean; current: QuestRow; decision: DecisionRow }> => {
  if (!isPendingProtocolState(decision.state)) {
    return { expired: false, current, decision };
  }
  const resolutionCode = decision.state === 'UNDERFILLED_DECISION_PENDING'
    ? 'HIRER_DECISION_TIMEOUT'
    : 'WORKER_CONSENT_TIMEOUT';
  const expired = decision.state === 'UNDERFILLED_DECISION_PENDING'
    ? now.getTime() >= decision.decisionExpiresAt.getTime()
    : decision.consentExpiresAt !== null && now.getTime() >= decision.consentExpiresAt.getTime();
  if (!expired) return { expired: false, current, decision };
  const result = await cancelUnderfilledInTransaction(
    transaction,
    current,
    decision,
    resolutionCode,
    now,
  );
  return { expired: true, ...result };
};

const materialize = async (
  transaction: QuestTransaction,
  memberId: string,
  questId: string,
  now: Date,
): Promise<QuestV2UnderfilledData | { outcome: OutcomeCode }> => {
  let current = await lockQuest(transaction, questId);
  if (!current) return { outcome: 'not-found' };
  const isHirer = current.hirerId === memberId;
  if (!isHirer && !(await hasActiveAssignment(transaction, questId, memberId))) {
    return { outcome: 'not-authorized' };
  }
  let decision = await selectDecision(transaction, questId, true);
  if (!decision) {
    const created = await createDecisionInTransaction(transaction, current, now);
    if (!created.underfilled) return { outcome: 'not-underfilled' };
    decision = await selectDecision(transaction, questId, true);
  }
  if (!decision) return { outcome: 'not-underfilled' };

  const ownResponse = (await selectConsents(transaction, decision.id)).find(({ workerId }) => workerId === memberId);
  if (!isHirer && !ownResponse) return { outcome: 'not-authorized' };

  if (current.questState !== 'QUEST_OPEN' && isPendingProtocolState(decision.state)) {
    const cancelled = await cancelUnderfilledInTransaction(
      transaction,
      current,
      decision,
      'HIRER_CANCELLED',
      now,
    );
    current = cancelled.current;
    decision = cancelled.decision;
  }

  const expired = await expireInTransaction(transaction, current, decision, now);
  if (expired.expired) {
    current = expired.current;
    decision = expired.decision;
  }
  const result = await project(transaction, memberId, current, decision);
  return result ?? { outcome: 'not-authorized' };
};

export const detectQuestV2Underfilled = async (
  questId: string,
  now = new Date(),
): Promise<QuestV2UnderfilledDetectionResult> => db.transaction(async (transaction) => {
  const current = await lockQuest(transaction, questId);
  if (!current) return { underfilled: false, created: false };
  return createDecisionInTransaction(transaction, current, now);
});

export const getQuestV2Underfilled = async (
  memberId: string,
  questId: string,
  now = new Date(),
): Promise<QuestV2UnderfilledOutcome> => db.transaction(async (transaction) => {
  const result = await materialize(transaction, memberId, questId, now);
  return 'outcome' in result ? result : { underfilled: result };
});

export const decideQuestV2Underfilled = async (
  hirerId: string,
  questId: string,
  data: QuestV2UnderfilledDecisionInput,
  rawIdempotencyKey: string,
  now = new Date(),
): Promise<QuestV2UnderfilledOutcome> => {
  const key = rawIdempotencyKey.trim();
  if (key.length === 0 || key.length > 200) return { outcome: 'invalid-idempotency-key' };
  if (!isDecision(data?.decision)) return { outcome: 'not-pending' };
  const requestHash = await requestHashFor(
    hirerId,
    questId,
    questV2UnderfilledDecisionOperationScope,
    '/api/v2/quests/:questId/underfilled/decision',
    data.decision,
  );

  return db.transaction(async (transaction) => {
    const current = await lockQuest(transaction, questId);
    if (!current) return { outcome: 'not-found' };
    const idempotency = await acquireIdempotency(
      transaction,
      hirerId,
      questV2UnderfilledDecisionOperationScope,
      key,
      requestHash,
      now,
    );
    const replay = replayOrOutcome(idempotency);
    if (replay) return replay;
    if ('outcome' in idempotency) return idempotency;
    const discard = async (outcome: BusinessOutcomeCode): Promise<QuestV2UnderfilledOutcome> => {
      await transaction.delete(walletIdempotencyKey).where(eq(walletIdempotencyKey.id, idempotency.record.id));
      return { outcome };
    };

    if (current.hirerId !== hirerId) return discard('not-authorized');
    let decision = await selectDecision(transaction, questId, true);
    if (!decision) {
      const created = await createDecisionInTransaction(transaction, current, now);
      if (!created.underfilled) return discard('not-underfilled');
      decision = await selectDecision(transaction, questId, true);
    }
    if (!decision) return discard('not-underfilled');
    if (current.questState !== 'QUEST_OPEN') return discard('not-pending');
    if (decision.state !== 'UNDERFILLED_DECISION_PENDING') return discard('not-pending');
    const expired = await expireInTransaction(transaction, current, decision, now);
    if (expired.expired) {
      await transaction.delete(walletIdempotencyKey).where(eq(walletIdempotencyKey.id, idempotency.record.id));
      return { outcome: 'expired' };
    }

    let nextCurrent = current;
    let nextDecision = decision;
    if (data.decision === 'CANCEL') {
      const cancelled = await cancelUnderfilledInTransaction(
        transaction,
        current,
        decision,
        'HIRER_CANCELLED',
        now,
      );
      nextCurrent = cancelled.current;
      nextDecision = cancelled.decision;
    } else {
      const [updated] = await transaction
        .update(questV2UnderfilledDecision)
        .set({
          state: 'UNDERFILLED_CONSENT_PENDING',
          decision: 'PROCEED',
          consentExpiresAt: new Date(now.getTime() + WINDOW_MILLISECONDS),
        })
        .where(and(
          eq(questV2UnderfilledDecision.id, decision.id),
          eq(questV2UnderfilledDecision.state, 'UNDERFILLED_DECISION_PENDING'),
        ))
        .returning();
      if (!updated) return discard('not-pending');
      nextDecision = updated;
    }
    const dataResult = await project(transaction, hirerId, nextCurrent, nextDecision);
    if (!dataResult) throw new Error(`Underfilled Decision ${nextDecision.id} could not be projected`);
    await completeIdempotency(transaction, idempotency.record.id, nextDecision.id, dataResult, now);
    return { underfilled: dataResult };
  });
};

export const respondToQuestV2Underfilled = async (
  workerId: string,
  questId: string,
  data: QuestV2UnderfilledConsentInput,
  rawIdempotencyKey: string,
  now = new Date(),
): Promise<QuestV2UnderfilledOutcome> => {
  const key = rawIdempotencyKey.trim();
  if (key.length === 0 || key.length > 200) return { outcome: 'invalid-idempotency-key' };
  if (!isConsentDecision(data?.decision)) return { outcome: 'not-pending' };
  const requestHash = await requestHashFor(
    workerId,
    questId,
    questV2UnderfilledConsentOperationScope,
    '/api/v2/quests/:questId/underfilled/consent',
    data.decision,
  );

  return db.transaction(async (transaction) => {
    const current = await lockQuest(transaction, questId);
    if (!current) return { outcome: 'not-found' };
    const idempotency = await acquireIdempotency(
      transaction,
      workerId,
      questV2UnderfilledConsentOperationScope,
      key,
      requestHash,
      now,
    );
    const replay = replayOrOutcome(idempotency);
    if (replay) return replay;
    if ('outcome' in idempotency) return idempotency;
    const discard = async (outcome: BusinessOutcomeCode): Promise<QuestV2UnderfilledOutcome> => {
      await transaction.delete(walletIdempotencyKey).where(eq(walletIdempotencyKey.id, idempotency.record.id));
      return { outcome };
    };

    if (current.hirerId === workerId || !(await hasActiveAssignment(transaction, questId, workerId))) {
      return discard('not-authorized');
    }
    let decision = await selectDecision(transaction, questId, true);
    if (!decision) {
      const created = await createDecisionInTransaction(transaction, current, now);
      if (!created.underfilled) return discard('not-underfilled');
      decision = await selectDecision(transaction, questId, true);
    }
    if (!decision) return discard('not-underfilled');
    const consents = await selectConsents(transaction, decision.id, true);
    const ownResponse = consents.find(({ workerId: candidate }) => candidate === workerId);
    if (!ownResponse) return discard('not-authorized');
    if (current.questState !== 'QUEST_OPEN') return discard('not-pending');
    const expired = await expireInTransaction(transaction, current, decision, now);
    if (expired.expired) {
      await transaction.delete(walletIdempotencyKey).where(eq(walletIdempotencyKey.id, idempotency.record.id));
      return { outcome: 'expired' };
    }
    if (decision.state !== 'UNDERFILLED_CONSENT_PENDING') {
      return discard(ownResponse.decision === null ? 'not-pending' : 'already-responded');
    }
    if (ownResponse.decision !== null) return discard('already-responded');

    const [updatedResponse] = await transaction
      .update(questV2UnderfilledConsent)
      .set({ decision: data.decision as QuestV2UnderfilledConsentDecision, respondedAt: now })
      .where(and(
        eq(questV2UnderfilledConsent.id, ownResponse.id),
        isNull(questV2UnderfilledConsent.decision),
      ))
      .returning();
    if (!updatedResponse) return discard('already-responded');

    let nextCurrent = current;
    let nextDecision = decision;
    if (data.decision === 'DECLINE') {
      const cancelled = await cancelUnderfilledInTransaction(
        transaction,
        current,
        decision,
        'WORKER_DECLINED',
        now,
      );
      nextCurrent = cancelled.current;
      nextDecision = cancelled.decision;
    } else {
      const responses = await selectConsents(transaction, decision.id);
      if (responses.every(({ decision: responseDecision }) => responseDecision === 'ACCEPT')) {
        const [completed] = await transaction
          .update(questV2UnderfilledDecision)
          .set({ state: 'UNDERFILLED_COMPLETED', resolvedAt: now })
          .where(and(
            eq(questV2UnderfilledDecision.id, decision.id),
            eq(questV2UnderfilledDecision.state, 'UNDERFILLED_CONSENT_PENDING'),
          ))
          .returning();
        if (!completed) return discard('not-pending');
        await transaction
          .update(quest)
          .set({ questStatus: 'QUEST_ASSIGNED', updatedAt: now })
          .where(and(eq(quest.id, questId), eq(quest.questStatus, 'QUEST_OPEN')));
        nextDecision = completed;
        nextCurrent = { ...current, questState: 'QUEST_ASSIGNED' };
      }
    }

    const dataResult = await project(transaction, workerId, nextCurrent, nextDecision);
    if (!dataResult) throw new Error(`Underfilled Decision ${nextDecision.id} could not be projected`);
    await completeIdempotency(transaction, idempotency.record.id, nextDecision.id, dataResult, now);
    return { underfilled: dataResult };
  });
};

export const expireQuestV2Underfilled = async (
  questId: string,
  now = new Date(),
): Promise<boolean> => db.transaction(async (transaction) => {
  const current = await lockQuest(transaction, questId);
  if (!current) return false;
  const decision = await selectDecision(transaction, questId, true);
  if (!decision) return false;
  const result = await expireInTransaction(transaction, current, decision, now);
  return result.expired;
});

export const pendingQuestV2UnderfilledQuestIds = async (now: Date, limit: number) => db
  .select({ questId: questV2UnderfilledDecision.questId })
  .from(questV2UnderfilledDecision)
  .where(or(
    and(
      eq(questV2UnderfilledDecision.state, 'UNDERFILLED_DECISION_PENDING'),
      lte(questV2UnderfilledDecision.decisionExpiresAt, now),
    ),
    and(
      eq(questV2UnderfilledDecision.state, 'UNDERFILLED_CONSENT_PENDING'),
      lte(questV2UnderfilledDecision.consentExpiresAt, now),
    ),
  ))
  .orderBy(asc(questV2UnderfilledDecision.decisionExpiresAt), asc(questV2UnderfilledDecision.id))
  .limit(limit);
