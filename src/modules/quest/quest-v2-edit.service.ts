import { db } from '@/database/client';
import {
  quest,
  questAssignment,
  questConditionItem,
  questV2EditRequest,
  questV2EditRequestResponse,
} from '@/database/schema/quest.schema';
import { walletIdempotencyKey } from '@/database/schema/wallet.schema';

import { and, asc, eq, sql } from 'drizzle-orm';

import {
  questV2EditFailureCodes,
  questV2EditRequestStatuses,
  questV2EditResponseDecisions,
  type QuestV2EditFailureCode,
  type QuestV2EditRequestStatus,
  type QuestV2EditResponseDecision,
} from './quest-v2.contract';
import { questStatus } from './quest.contract';
import type {
  QuestV2EditRequestCreateInput,
  QuestV2EditRequestData,
  QuestV2EditRequestResponseInput,
} from './quest-v2.schema';

export type QuestTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type ConditionItem = { position: number; text: string };
type ConditionSnapshot = { items: ConditionItem[] };
type QuestV2EditRequestRow = typeof questV2EditRequest.$inferSelect;
type QuestV2EditResponseRow = typeof questV2EditRequestResponse.$inferSelect;

export const questV2EditRequestCreateOperationScope = 'quest.v2.edit-request.create';
export const questV2EditRequestRespondOperationScope = 'quest.v2.edit-request.respond';

type QuestV2EditOutcomeCode =
  | 'invalid-input'
  | 'invalid-idempotency-key'
  | 'not-found'
  | 'not-assigned'
  | 'pending-request'
  | 'no-active-workers'
  | 'no-change'
  | 'not-pending'
  | 'already-responded'
  | 'expired'
  | 'idempotency-key-reused'
  | 'idempotency-in-progress'
  | 'idempotency-unavailable';

export type QuestV2EditRequestOutcome =
  | { request: QuestV2EditRequestData }
  | { outcome: QuestV2EditOutcomeCode };

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
  | { outcome: 'idempotency-key-reused' | 'idempotency-in-progress' | 'idempotency-unavailable' };

const sha256Json = async (value: object): Promise<string> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const idempotencyExpiry = (now: Date) => new Date(now.getTime() + 24 * 60 * 60 * 1000);

const validStatus = (value: unknown): value is QuestV2EditRequestStatus =>
  typeof value === 'string' && (questV2EditRequestStatuses as readonly string[]).includes(value);

const validDecision = (value: unknown): value is QuestV2EditResponseDecision =>
  typeof value === 'string' && (questV2EditResponseDecisions as readonly string[]).includes(value);

const validFailureCode = (value: unknown): value is QuestV2EditFailureCode =>
  typeof value === 'string' && (questV2EditFailureCodes as readonly string[]).includes(value);

const validOutcome = (value: unknown): value is QuestV2EditOutcomeCode =>
  typeof value === 'string' && [
    'invalid-input',
    'invalid-idempotency-key',
    'not-found',
    'not-assigned',
    'pending-request',
    'no-active-workers',
    'no-change',
    'not-pending',
    'already-responded',
    'expired',
    'idempotency-key-reused',
    'idempotency-in-progress',
    'idempotency-unavailable',
  ].includes(value);

const isConditionSnapshot = (value: unknown): value is ConditionSnapshot => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const items = (value as { items?: unknown }).items;
  return (
    Array.isArray(items) &&
    items.length > 0 &&
    items.every((item, position) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const candidate = item as Partial<ConditionItem>;
      return (
        candidate.position === position &&
        typeof candidate.text === 'string' &&
        candidate.text.trim().length > 0 &&
        candidate.text.length <= 255
      );
    })
  );
};

const toConditionSnapshot = (items: ConditionItem[]): ConditionSnapshot => ({
  items: items.map((item, position) => ({ position, text: item.text })),
});

const conditionItemsEqual = (left: ConditionItem[], right: ConditionItem[]) =>
  left.length === right.length && left.every((item, position) => item.text === right[position]?.text);

const normalizeCondition = (
  data: QuestV2EditRequestCreateInput,
): ConditionSnapshot | undefined => {
  if (!data || !data.condition || !Array.isArray(data.condition.items)) return undefined;
  const items = data.condition.items.map((text) => text.trim());
  if (items.length === 0 || items.some((text) => text.length === 0 || text.length > 255)) {
    return undefined;
  }
  return toConditionSnapshot(items.map((text, position) => ({ position, text })));
};

const normalizeResponse = (
  data: QuestV2EditRequestResponseInput,
): { decision: QuestV2EditResponseDecision; reason: string | null } | undefined => {
  if (!data || !validDecision(data.decision)) return undefined;
  const reason = data.reason?.trim() ?? null;
  if (reason !== null && (reason.length === 0 || reason.length > 255)) return undefined;
  if (data.decision === 'EDIT_RESPONSE_ACCEPTED' && reason !== null) return undefined;
  return { decision: data.decision, reason };
};

const createRequestHash = (
  userId: string,
  questId: string,
  condition: ConditionSnapshot,
): Promise<string> => sha256Json({
  authenticatedMemberId: userId,
  operation: questV2EditRequestCreateOperationScope,
  path: '/api/v2/quests/:questId/edit-requests',
  questId,
  body: { condition },
});

const respondRequestHash = (
  userId: string,
  requestId: string,
  response: { decision: QuestV2EditResponseDecision; reason: string | null },
): Promise<string> => sha256Json({
  authenticatedMemberId: userId,
  operation: questV2EditRequestRespondOperationScope,
  path: '/api/v2/quests/edit-requests/:requestId/respond',
  requestId,
  body: response,
});

const idempotencyFields = {
  id: walletIdempotencyKey.id,
  requestHash: walletIdempotencyKey.requestHash,
  resourceId: walletIdempotencyKey.resourceId,
  resultData: walletIdempotencyKey.resultData,
  processingStatus: walletIdempotencyKey.processingStatus,
};

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

  const record = created ?? (
    await transaction
      .select(idempotencyFields)
      .from(walletIdempotencyKey)
      .where(and(
        eq(walletIdempotencyKey.principalUserId, userId),
        eq(walletIdempotencyKey.operationScope, operationScope),
        eq(walletIdempotencyKey.key, key),
      ))
      .limit(1)
      .for('update')
  )[0];

  if (!record) return { outcome: 'idempotency-unavailable' };
  if (record.requestHash !== requestHash) return { outcome: 'idempotency-key-reused' };
  if (created) return { created: true, record };
  if (record.resourceId) return { created: false, record };
  if (record.processingStatus === 'PROCESSING') return { outcome: 'idempotency-in-progress' };
  return { outcome: 'idempotency-unavailable' };
};

const parseReplay = (
  record: IdempotencyRecord,
): QuestV2EditRequestOutcome | undefined => {
  if (!record.resultData || typeof record.resultData !== 'object' || Array.isArray(record.resultData)) {
    return undefined;
  }
  const result = record.resultData as { request?: unknown; outcome?: unknown };
  if (validOutcome(result.outcome)) {
    return { outcome: result.outcome };
  }
  if (result.request && isQuestV2EditRequestData(result.request)) {
    return { request: result.request };
  }
  return undefined;
};

const isQuestV2EditRequestData = (value: unknown): value is QuestV2EditRequestData => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Partial<QuestV2EditRequestData>;
  return (
    typeof data.requestId === 'string' &&
    typeof data.questId === 'string' &&
    validStatus(data.status) &&
    (data.failureCode === null || validFailureCode(data.failureCode)) &&
    typeof data.createdAt === 'string' &&
    typeof data.expiresAt === 'string' &&
    (data.appliedAt === null || typeof data.appliedAt === 'string') &&
    (data.failedAt === null || typeof data.failedAt === 'string') &&
    isConditionSnapshot(data.previousCondition) &&
    isConditionSnapshot(data.proposedCondition) &&
    data.responseSummary !== undefined &&
    typeof data.responseSummary === 'object' &&
    data.responseSummary !== null &&
    Number.isInteger(data.responseSummary.totalCount) &&
    Number.isInteger(data.responseSummary.acceptedCount) &&
    Number.isInteger(data.responseSummary.declinedCount) &&
    Number.isInteger(data.responseSummary.pendingCount) &&
    (data.responses === undefined || Array.isArray(data.responses)) &&
    (data.ownResponse === undefined || data.ownResponse === null || typeof data.ownResponse === 'object')
  );
};

const completeIdempotency = async (
  transaction: QuestTransaction,
  idempotencyId: string,
  resourceId: string,
  resultData: object,
  now: Date,
) => {
  await transaction
    .update(walletIdempotencyKey)
    .set({
      resourceType: 'quest-v2-edit-request',
      resourceId,
      resultData,
      processingStatus: 'COMPLETED',
      completedAt: now,
    })
    .where(eq(walletIdempotencyKey.id, idempotencyId));
};

const completeOutcome = async (
  transaction: QuestTransaction,
  idempotencyId: string,
  resourceId: string,
  outcome: QuestV2EditOutcomeCode,
  now: Date,
): Promise<QuestV2EditRequestOutcome> => {
  await completeIdempotency(transaction, idempotencyId, resourceId, { outcome }, now);
  return { outcome };
};

const selectQuestForEdit = async (transaction: QuestTransaction, questId: string) => {
  const [row] = await transaction
    .select({
      id: quest.id,
      hirerId: quest.hirerId,
      apiVersion: quest.apiVersion,
      questStatus: quest.questStatus,
    })
    .from(quest)
    .where(eq(quest.id, questId))
    .limit(1)
    .for('update');
  return row;
};

const selectRequest = async (transaction: QuestTransaction, requestId: string, lock = false) => {
  const query = transaction
    .select()
    .from(questV2EditRequest)
    .where(eq(questV2EditRequest.id, requestId))
    .limit(1);
  const rows = await (lock ? query.for('update') : query);
  return rows[0];
};

const selectCondition = async (
  transaction: QuestTransaction,
  questId: string,
): Promise<ConditionItem[]> => transaction
  .select({ position: questConditionItem.position, text: questConditionItem.text })
  .from(questConditionItem)
  .where(eq(questConditionItem.questId, questId))
  .orderBy(asc(questConditionItem.position));

const selectResponses = async (
  transaction: QuestTransaction,
  requestId: string,
): Promise<QuestV2EditResponseRow[]> => transaction
  .select()
  .from(questV2EditRequestResponse)
  .where(eq(questV2EditRequestResponse.requestId, requestId))
  .orderBy(asc(questV2EditRequestResponse.workerId));

const failRequest = async (
  transaction: QuestTransaction,
  request: QuestV2EditRequestRow,
  failureCode: QuestV2EditFailureCode,
  now: Date,
): Promise<QuestV2EditRequestRow> => {
  await transaction
    .update(questV2EditRequest)
    .set({
      requestStatus: 'EDIT_REQUEST_FAILED',
      failureCode,
      failedAt: now,
    })
    .where(and(
      eq(questV2EditRequest.id, request.id),
      eq(questV2EditRequest.requestStatus, 'EDIT_REQUEST_PENDING'),
    ));
  return {
    ...request,
    requestStatus: 'EDIT_REQUEST_FAILED',
    failureCode,
    failedAt: now,
  };
};

const materializePendingRequest = async (
  transaction: QuestTransaction,
  questId: string,
  request: QuestV2EditRequestRow,
  now: Date,
): Promise<{ request: QuestV2EditRequestRow; outcome?: 'expired' | 'departed' }> => {
  if (request.requestStatus !== 'EDIT_REQUEST_PENDING') return { request };

  const snapshot = await transaction
    .select({ workerId: questV2EditRequestResponse.workerId })
    .from(questV2EditRequestResponse)
    .where(eq(questV2EditRequestResponse.requestId, request.id));
  const active = await transaction
    .select({ workerId: questAssignment.workerId })
    .from(questAssignment)
    .where(and(
      eq(questAssignment.questId, questId),
      eq(questAssignment.assignmentStatus, 'ASSIGNMENT_ACTIVE'),
    ));
  const snapshotIds = snapshot.map(({ workerId }) => workerId).sort();
  const activeIds = active.map(({ workerId }) => workerId).sort();
  if (snapshotIds.length !== activeIds.length || snapshotIds.some((id, index) => id !== activeIds[index])) {
    return {
      request: await failRequest(transaction, request, 'ACTIVE_WORKER_LEFT', now),
      outcome: 'departed',
    };
  }

  if (now.getTime() >= request.expiresAt.getTime()) {
    return {
      request: await failRequest(transaction, request, 'EDIT_REQUEST_TIMEOUT', now),
      outcome: 'expired',
    };
  }

  return { request };
};

const responseSummary = (responses: QuestV2EditResponseRow[]) => ({
  totalCount: responses.length,
  acceptedCount: responses.filter((response) => response.decision === 'EDIT_RESPONSE_ACCEPTED').length,
  declinedCount: responses.filter((response) => response.decision === 'EDIT_RESPONSE_DECLINED').length,
  pendingCount: responses.filter((response) => response.decision === null).length,
});

const projectRequest = async (
  transaction: QuestTransaction,
  memberId: string,
  questRow: { hirerId: string },
  request: QuestV2EditRequestRow,
): Promise<QuestV2EditRequestData | undefined> => {
  if (!isConditionSnapshot(request.previousCondition) || !isConditionSnapshot(request.proposedCondition)) {
    throw new Error(`Quest Edit Request ${request.id} has invalid Condition snapshots`);
  }
  const responses = await selectResponses(transaction, request.id);
  const ownResponse = responses.find((response) => response.workerId === memberId);
  const isHirer = questRow.hirerId === memberId;
  if (!isHirer) {
    if (!ownResponse) return undefined;
    const [activeAssignment] = await transaction
      .select({ id: questAssignment.id })
      .from(questAssignment)
      .where(and(
        eq(questAssignment.questId, request.questId),
        eq(questAssignment.workerId, memberId),
        eq(questAssignment.assignmentStatus, 'ASSIGNMENT_ACTIVE'),
      ))
      .limit(1);
    if (!activeAssignment) return undefined;
  }

  const result: QuestV2EditRequestData = {
    requestId: request.id,
    questId: request.questId,
    status: request.requestStatus,
    failureCode: request.failureCode,
    createdAt: request.createdAt.toISOString(),
    expiresAt: request.expiresAt.toISOString(),
    appliedAt: request.appliedAt?.toISOString() ?? null,
    failedAt: request.failedAt?.toISOString() ?? null,
    previousCondition: request.previousCondition,
    proposedCondition: request.proposedCondition,
    responseSummary: responseSummary(responses),
  };

  if (isHirer) {
    result.responses = responses.map((response) => ({
      workerId: response.workerId,
      decision: response.decision,
      reason: response.reason,
      respondedAt: response.respondedAt?.toISOString() ?? null,
    }));
  } else {
    result.ownResponse = ownResponse
      ? {
          decision: ownResponse.decision,
          reason: ownResponse.reason,
          respondedAt: ownResponse.respondedAt?.toISOString() ?? null,
        }
      : null;
  }

  return result;
};

const replayOrOutcome = (
  idempotency: IdempotencyResult,
): QuestV2EditRequestOutcome | undefined => {
  if ('outcome' in idempotency) return { outcome: idempotency.outcome };
  if (!idempotency.created) return parseReplay(idempotency.record) ?? { outcome: 'idempotency-unavailable' };
  return undefined;
};

export const createQuestV2EditRequest = async (
  userId: string,
  questId: string,
  data: QuestV2EditRequestCreateInput,
  rawIdempotencyKey: string,
  now = new Date(),
): Promise<QuestV2EditRequestOutcome> => {
  const key = rawIdempotencyKey.trim();
  const condition = normalizeCondition(data);
  if (key.length === 0 || key.length > 200) return { outcome: 'invalid-idempotency-key' };
  if (!condition) return { outcome: 'invalid-input' };

  const requestHash = await createRequestHash(userId, questId, condition);
  return db.transaction(async (transaction) => {
    const idempotency = await acquireIdempotency(
      transaction,
      userId,
      questV2EditRequestCreateOperationScope,
      key,
      requestHash,
      now,
    );
    const replay = replayOrOutcome(idempotency);
    if (replay) return replay;
    if ('outcome' in idempotency) return idempotency;

    const current = await selectQuestForEdit(transaction, questId);
    if (!current || current.apiVersion !== 'v2' || current.hirerId !== userId) {
      return completeOutcome(transaction, idempotency.record.id, questId, 'not-found', now);
    }
    if (current.questStatus !== questStatus.assigned) {
      return completeOutcome(transaction, idempotency.record.id, questId, 'not-assigned', now);
    }

    const [pendingIdentity] = await transaction
      .select({ id: questV2EditRequest.id })
      .from(questV2EditRequest)
      .where(and(
        eq(questV2EditRequest.questId, questId),
        eq(questV2EditRequest.requestStatus, 'EDIT_REQUEST_PENDING'),
      ))
      .limit(1);
    if (pendingIdentity) {
      const pending = await selectRequest(transaction, pendingIdentity.id, true);
      if (!pending) return completeOutcome(transaction, idempotency.record.id, questId, 'not-found', now);
      const materialized = await materializePendingRequest(transaction, questId, pending, now);
      if (materialized.request.requestStatus === 'EDIT_REQUEST_PENDING') {
        return completeOutcome(transaction, idempotency.record.id, questId, 'pending-request', now);
      }
    }

    const previousItems = await selectCondition(transaction, questId);
    if (previousItems.length === 0) throw new Error(`Quest ${questId} has no Condition Items`);
    if (conditionItemsEqual(previousItems, condition.items)) {
      return completeOutcome(transaction, idempotency.record.id, questId, 'no-change', now);
    }

    const workers = await transaction
      .select({ workerId: questAssignment.workerId })
      .from(questAssignment)
      .where(and(
        eq(questAssignment.questId, questId),
        eq(questAssignment.assignmentStatus, 'ASSIGNMENT_ACTIVE'),
      ))
      .orderBy(asc(questAssignment.workerId))
      .for('update');
    if (workers.length === 0) {
      return completeOutcome(transaction, idempotency.record.id, questId, 'no-active-workers', now);
    }

    const [created] = await transaction
      .insert(questV2EditRequest)
      .values({
        questId,
        previousCondition: toConditionSnapshot(previousItems),
        proposedCondition: condition,
        requestStatus: 'EDIT_REQUEST_PENDING',
        createdAt: now,
        expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
      })
      .returning();
    if (!created) return { outcome: 'idempotency-unavailable' };

    await transaction.insert(questV2EditRequestResponse).values(
      workers.map(({ workerId }) => ({ requestId: created.id, workerId })),
    );
    const resource = await projectRequest(transaction, userId, current, created);
    if (!resource) throw new Error(`Quest Edit Request ${created.id} could not be projected`);
    await completeIdempotency(transaction, idempotency.record.id, created.id, { request: resource }, now);
    return { request: resource };
  });
};

export const respondToQuestV2EditRequest = async (
  userId: string,
  requestId: string,
  data: QuestV2EditRequestResponseInput,
  rawIdempotencyKey: string,
  now = new Date(),
): Promise<QuestV2EditRequestOutcome> => {
  const key = rawIdempotencyKey.trim();
  const responseInput = normalizeResponse(data);
  if (key.length === 0 || key.length > 200) return { outcome: 'invalid-idempotency-key' };
  if (!responseInput) return { outcome: 'invalid-input' };

  const requestHash = await respondRequestHash(userId, requestId, responseInput);
  return db.transaction(async (transaction) => {
    const idempotency = await acquireIdempotency(
      transaction,
      userId,
      questV2EditRequestRespondOperationScope,
      key,
      requestHash,
      now,
    );
    const replay = replayOrOutcome(idempotency);
    if (replay) return replay;
    if ('outcome' in idempotency) return idempotency;

    const [identity] = await transaction
      .select({ questId: questV2EditRequest.questId })
      .from(questV2EditRequest)
      .where(eq(questV2EditRequest.id, requestId))
      .limit(1);
    if (!identity) {
      return completeOutcome(transaction, idempotency.record.id, requestId, 'not-found', now);
    }

    const currentQuest = await selectQuestForEdit(transaction, identity.questId);
    if (!currentQuest || currentQuest.apiVersion !== 'v2') {
      return completeOutcome(transaction, idempotency.record.id, requestId, 'not-found', now);
    }
    const request = await selectRequest(transaction, requestId, true);
    if (!request) return completeOutcome(transaction, idempotency.record.id, requestId, 'not-found', now);

    const materialized = await materializePendingRequest(
      transaction,
      request.questId,
      request,
      now,
    );
    const ownResponse = (await selectResponses(transaction, requestId))
      .find((candidate) => candidate.workerId === userId);
    const [activeAssignment] = await transaction
      .select({ id: questAssignment.id })
      .from(questAssignment)
      .where(and(
        eq(questAssignment.questId, request.questId),
        eq(questAssignment.workerId, userId),
        eq(questAssignment.assignmentStatus, 'ASSIGNMENT_ACTIVE'),
      ))
      .limit(1);
    if (!ownResponse || !activeAssignment) {
      return completeOutcome(transaction, idempotency.record.id, requestId, 'not-found', now);
    }
    if (currentQuest.questStatus !== questStatus.assigned) {
      return completeOutcome(transaction, idempotency.record.id, requestId, 'not-pending', now);
    }
    if (materialized.outcome === 'expired') {
      return completeOutcome(transaction, idempotency.record.id, requestId, 'expired', now);
    }
    if (materialized.request.requestStatus !== 'EDIT_REQUEST_PENDING') {
      if (materialized.request.failureCode === 'EDIT_REQUEST_TIMEOUT') {
        return completeOutcome(transaction, idempotency.record.id, requestId, 'expired', now);
      }
      return completeOutcome(transaction, idempotency.record.id, requestId, 'not-pending', now);
    }
    if (ownResponse.decision !== null) {
      return completeOutcome(transaction, idempotency.record.id, requestId, 'already-responded', now);
    }

    await transaction
      .update(questV2EditRequestResponse)
      .set({
        decision: responseInput.decision,
        reason: responseInput.reason,
        respondedAt: now,
      })
      .where(eq(questV2EditRequestResponse.id, ownResponse.id));

    if (responseInput.decision === 'EDIT_RESPONSE_DECLINED') {
      await transaction
        .update(questV2EditRequest)
        .set({
          requestStatus: 'EDIT_REQUEST_FAILED',
          failureCode: 'EDIT_REQUEST_DECLINED',
          failedAt: now,
        })
        .where(eq(questV2EditRequest.id, requestId));
    } else {
      const responses = await selectResponses(transaction, requestId);
      if (responses.every((candidate) => candidate.decision === 'EDIT_RESPONSE_ACCEPTED')) {
        if (!isConditionSnapshot(request.proposedCondition)) {
          throw new Error(`Quest Edit Request ${request.id} has invalid proposed Condition`);
        }
        await transaction.delete(questConditionItem).where(eq(questConditionItem.questId, request.questId));
        await transaction.insert(questConditionItem).values(
          request.proposedCondition.items.map(({ position, text }) => ({
            questId: request.questId,
            position,
            text,
          })),
        );
        await transaction
          .update(quest)
          .set({
            condition: request.proposedCondition.items.map(({ text }) => text).join('\n').slice(0, 4000),
            version: sql`${quest.version} + 1`,
            updatedAt: now,
          })
          .where(and(eq(quest.id, request.questId), eq(quest.questStatus, questStatus.assigned)));
        await transaction
          .update(questV2EditRequest)
          .set({
            requestStatus: 'EDIT_REQUEST_APPLIED',
            appliedAt: now,
          })
          .where(eq(questV2EditRequest.id, requestId));
      }
    }

    const updatedRequest = await selectRequest(transaction, requestId);
    if (!updatedRequest) throw new Error(`Quest Edit Request ${requestId} could not be read back`);
    const resource = await projectRequest(transaction, userId, currentQuest, updatedRequest);
    if (!resource) throw new Error(`Quest Edit Request ${requestId} could not be projected`);
    await completeIdempotency(transaction, idempotency.record.id, requestId, { request: resource }, now);
    return { request: resource };
  });
};

export const getQuestV2EditRequest = async (
  userId: string,
  requestId: string,
  now = new Date(),
): Promise<QuestV2EditRequestData | undefined> => db.transaction(async (transaction) => {
  const [identity] = await transaction
    .select({ questId: questV2EditRequest.questId })
    .from(questV2EditRequest)
    .where(eq(questV2EditRequest.id, requestId))
    .limit(1);
  if (!identity) return undefined;

  const currentQuest = await selectQuestForEdit(transaction, identity.questId);
  if (!currentQuest || currentQuest.apiVersion !== 'v2') return undefined;
  const request = await selectRequest(transaction, requestId, true);
  if (!request) return undefined;
  const materialized = await materializePendingRequest(transaction, request.questId, request, now);
  return projectRequest(transaction, userId, currentQuest, materialized.request);
});

export const expireQuestV2EditRequest = async (
  requestId: string,
  now = new Date(),
): Promise<boolean> => db.transaction(async (transaction) => {
  const [identity] = await transaction
    .select({ questId: questV2EditRequest.questId })
    .from(questV2EditRequest)
    .where(eq(questV2EditRequest.id, requestId))
    .limit(1);
  if (!identity) return false;
  const currentQuest = await selectQuestForEdit(transaction, identity.questId);
  if (!currentQuest) return false;
  const request = await selectRequest(transaction, requestId, true);
  if (!request) return false;
  const materialized = await materializePendingRequest(transaction, request.questId, request, now);
  return materialized.outcome === 'expired';
});

export const pendingQuestV2EditRequestIds = async (limit: number) => db
  .select({ id: questV2EditRequest.id })
  .from(questV2EditRequest)
  .where(eq(questV2EditRequest.requestStatus, 'EDIT_REQUEST_PENDING'))
  .orderBy(asc(questV2EditRequest.expiresAt), asc(questV2EditRequest.id))
  .limit(limit);

export const hasPendingQuestV2EditRequest = async (
  transaction: QuestTransaction,
  questId: string,
): Promise<boolean> => {
  const [pending] = await transaction
    .select({ id: questV2EditRequest.id })
    .from(questV2EditRequest)
    .where(and(
      eq(questV2EditRequest.questId, questId),
      eq(questV2EditRequest.requestStatus, 'EDIT_REQUEST_PENDING'),
    ))
    .limit(1);
  return Boolean(pending);
};
