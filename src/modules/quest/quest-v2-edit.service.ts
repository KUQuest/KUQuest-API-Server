import { db } from '@/database/client';
import {
  quest,
  questApiVersion,
  questAssignment,
  questConditionItem,
  questV2EditRequest,
  questV2EditRequestResponse,
} from '@/database/schema/quest.schema';

import { and, asc, eq, sql } from 'drizzle-orm';

import {
  runQuestCommand,
  sha256Json,
  type QuestCommandOutcomeCode,
  type QuestCommandWork,
} from './quest-command.service';
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

type QuestV2EditBusinessOutcomeCode =
  | 'not-found'
  | 'not-assigned'
  | 'pending-request'
  | 'no-active-workers'
  | 'no-change'
  | 'not-pending'
  | 'already-responded'
  | 'expired';

type QuestV2EditOutcomeCode =
  'invalid-input' | QuestV2EditBusinessOutcomeCode | QuestCommandOutcomeCode;

export type QuestV2EditRequestOutcome =
  { request: QuestV2EditRequestData } | { outcome: QuestV2EditOutcomeCode };

const validStatus = (value: unknown): value is QuestV2EditRequestStatus =>
  typeof value === 'string' && (questV2EditRequestStatuses as readonly string[]).includes(value);

const validDecision = (value: unknown): value is QuestV2EditResponseDecision =>
  typeof value === 'string' && (questV2EditResponseDecisions as readonly string[]).includes(value);

const validFailureCode = (value: unknown): value is QuestV2EditFailureCode =>
  typeof value === 'string' && (questV2EditFailureCodes as readonly string[]).includes(value);

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
  left.length === right.length &&
  left.every((item, position) => item.text === right[position]?.text);

const normalizeCondition = (data: QuestV2EditRequestCreateInput): ConditionSnapshot | undefined => {
  if (!data || !data.condition || !Array.isArray(data.condition.items)) return undefined;
  const items = data.condition.items.map((text) => text.trim());
  if (items.length === 0 || items.some((text) => text.length === 0 || text.length > 255)) {
    return undefined;
  }
  return toConditionSnapshot(items.map((text, position) => ({ position, text })));
};

const normalizeResponse = (
  data: QuestV2EditRequestResponseInput
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
  condition: ConditionSnapshot
): Promise<string> =>
  sha256Json({
    authenticatedMemberId: userId,
    operation: questV2EditRequestCreateOperationScope,
    path: '/api/v2/quests/:questId/edit-requests',
    questId,
    body: { condition },
  });

const respondRequestHash = (
  userId: string,
  requestId: string,
  response: { decision: QuestV2EditResponseDecision; reason: string | null }
): Promise<string> =>
  sha256Json({
    authenticatedMemberId: userId,
    operation: questV2EditRequestRespondOperationScope,
    path: '/api/v2/quests/edit-requests/:requestId/respond',
    requestId,
    body: response,
  });

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
    (data.ownResponse === undefined ||
      data.ownResponse === null ||
      typeof data.ownResponse === 'object')
  );
};

const requestFromSnapshot = (value: unknown): QuestV2EditRequestData | undefined =>
  isQuestV2EditRequestData(value) ? value : undefined;

const selectQuestForEdit = async (transaction: QuestTransaction, questId: string) => {
  const [row] = await transaction
    .select({
      hirerId: quest.hirerId,
      questStatus: quest.questStatus,
    })
    .from(quest)
    .where(and(eq(quest.id, questId), eq(quest.apiVersion, questApiVersion.v2)))
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
  questId: string
): Promise<ConditionItem[]> =>
  transaction
    .select({ position: questConditionItem.position, text: questConditionItem.text })
    .from(questConditionItem)
    .where(eq(questConditionItem.questId, questId))
    .orderBy(asc(questConditionItem.position));

const selectResponses = async (
  transaction: QuestTransaction,
  requestId: string
): Promise<QuestV2EditResponseRow[]> =>
  transaction
    .select()
    .from(questV2EditRequestResponse)
    .where(eq(questV2EditRequestResponse.requestId, requestId))
    .orderBy(asc(questV2EditRequestResponse.workerId));

const failRequest = async (
  transaction: QuestTransaction,
  request: QuestV2EditRequestRow,
  failureCode: QuestV2EditFailureCode,
  now: Date
): Promise<QuestV2EditRequestRow> => {
  await transaction
    .update(questV2EditRequest)
    .set({
      requestStatus: 'EDIT_REQUEST_FAILED',
      failureCode,
      failedAt: now,
    })
    .where(
      and(
        eq(questV2EditRequest.id, request.id),
        eq(questV2EditRequest.requestStatus, 'EDIT_REQUEST_PENDING')
      )
    );
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
  now: Date
): Promise<{ request: QuestV2EditRequestRow; outcome?: 'expired' | 'departed' }> => {
  if (request.requestStatus !== 'EDIT_REQUEST_PENDING') return { request };

  const snapshot = await transaction
    .select({ workerId: questV2EditRequestResponse.workerId })
    .from(questV2EditRequestResponse)
    .where(eq(questV2EditRequestResponse.requestId, request.id));
  const active = await transaction
    .select({ workerId: questAssignment.workerId })
    .from(questAssignment)
    .where(
      and(
        eq(questAssignment.questId, questId),
        eq(questAssignment.assignmentStatus, 'ASSIGNMENT_ACTIVE')
      )
    );
  const snapshotIds = snapshot.map(({ workerId }) => workerId).sort();
  const activeIds = active.map(({ workerId }) => workerId).sort();
  if (
    snapshotIds.length !== activeIds.length ||
    snapshotIds.some((id, index) => id !== activeIds[index])
  ) {
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
  acceptedCount: responses.filter((response) => response.decision === 'EDIT_RESPONSE_ACCEPTED')
    .length,
  declinedCount: responses.filter((response) => response.decision === 'EDIT_RESPONSE_DECLINED')
    .length,
  pendingCount: responses.filter((response) => response.decision === null).length,
});

const projectRequest = async (
  transaction: QuestTransaction,
  memberId: string,
  questRow: { hirerId: string },
  request: QuestV2EditRequestRow
): Promise<QuestV2EditRequestData | undefined> => {
  if (
    !isConditionSnapshot(request.previousCondition) ||
    !isConditionSnapshot(request.proposedCondition)
  ) {
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
      .where(
        and(
          eq(questAssignment.questId, request.questId),
          eq(questAssignment.workerId, memberId),
          eq(questAssignment.assignmentStatus, 'ASSIGNMENT_ACTIVE')
        )
      )
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

export const createQuestV2EditRequest = async (
  userId: string,
  questId: string,
  data: QuestV2EditRequestCreateInput,
  rawIdempotencyKey: string,
  now = new Date()
): Promise<QuestV2EditRequestOutcome> => {
  const condition = normalizeCondition(data);
  if (!condition) return { outcome: 'invalid-input' };

  const requestHash = await createRequestHash(userId, questId, condition);
  return db.transaction(async (transaction) => {
    // Lock before runQuestCommand: the Quest Command foreign key insert takes FOR KEY SHARE.
    const current = await selectQuestForEdit(transaction, questId);
    if (!current) return { outcome: 'not-found' };

    const command = await runQuestCommand({
      transaction,
      identity: {
        principalUserId: userId,
        operationScope: questV2EditRequestCreateOperationScope,
        key: rawIdempotencyKey,
        requestHash,
        questId,
      },
      now,
      work: async (): Promise<
        QuestCommandWork<QuestV2EditRequestData, QuestV2EditBusinessOutcomeCode>
      > => {
        if (current.hirerId !== userId) return { kind: 'rejected', rejection: 'not-found' };
        if (current.questStatus !== questStatus.assigned) {
          return { kind: 'rejected', rejection: 'not-assigned' };
        }

        const [pendingIdentity] = await transaction
          .select({ id: questV2EditRequest.id })
          .from(questV2EditRequest)
          .where(
            and(
              eq(questV2EditRequest.questId, questId),
              eq(questV2EditRequest.requestStatus, 'EDIT_REQUEST_PENDING')
            )
          )
          .limit(1);
        if (pendingIdentity) {
          const pending = await selectRequest(transaction, pendingIdentity.id, true);
          if (!pending) return { kind: 'rejected', rejection: 'not-found' };
          const materialized = await materializePendingRequest(transaction, questId, pending, now);
          if (materialized.request.requestStatus === 'EDIT_REQUEST_PENDING') {
            return { kind: 'rejected', rejection: 'pending-request' };
          }
        }

        const previousItems = await selectCondition(transaction, questId);
        if (previousItems.length === 0) throw new Error(`Quest ${questId} has no Condition Items`);
        if (conditionItemsEqual(previousItems, condition.items)) {
          return { kind: 'rejected', rejection: 'no-change' };
        }

        const workers = await transaction
          .select({ workerId: questAssignment.workerId })
          .from(questAssignment)
          .where(
            and(
              eq(questAssignment.questId, questId),
              eq(questAssignment.assignmentStatus, 'ASSIGNMENT_ACTIVE')
            )
          )
          .orderBy(asc(questAssignment.workerId))
          .for('update');
        if (workers.length === 0) {
          return { kind: 'rejected', rejection: 'no-active-workers' };
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
        if (!created) throw new Error('Quest Edit Request insert returned no row');

        await transaction
          .insert(questV2EditRequestResponse)
          .values(workers.map(({ workerId }) => ({ requestId: created.id, workerId })));
        const resource = await projectRequest(transaction, userId, current, created);
        if (!resource) throw new Error(`Quest Edit Request ${created.id} could not be projected`);
        return {
          kind: 'success',
          result: resource,
          resourceType: 'quest-v2-edit-request',
          resourceId: created.id,
        };
      },
      toSnapshot: (result) => result,
      fromSnapshot: requestFromSnapshot,
    });

    if ('outcome' in command) return { outcome: command.outcome };
    if (command.kind === 'success') return { request: command.result };
    return { outcome: command.rejection };
  });
};

export const respondToQuestV2EditRequest = async (
  userId: string,
  requestId: string,
  data: QuestV2EditRequestResponseInput,
  rawIdempotencyKey: string,
  now = new Date()
): Promise<QuestV2EditRequestOutcome> => {
  const responseInput = normalizeResponse(data);
  if (!responseInput) return { outcome: 'invalid-input' };

  const requestHash = await respondRequestHash(userId, requestId, responseInput);
  return db.transaction(async (transaction) => {
    const [identity] = await transaction
      .select({ questId: questV2EditRequest.questId })
      .from(questV2EditRequest)
      .where(eq(questV2EditRequest.id, requestId))
      .limit(1);
    if (!identity) return { outcome: 'not-found' };

    // Lock before runQuestCommand: the Quest Command foreign key insert takes FOR KEY SHARE.
    const currentQuest = await selectQuestForEdit(transaction, identity.questId);
    if (!currentQuest) return { outcome: 'not-found' };

    const command = await runQuestCommand({
      transaction,
      identity: {
        principalUserId: userId,
        operationScope: questV2EditRequestRespondOperationScope,
        key: rawIdempotencyKey,
        requestHash,
        questId: identity.questId,
      },
      now,
      work: async (): Promise<
        QuestCommandWork<QuestV2EditRequestData, QuestV2EditBusinessOutcomeCode>
      > => {
        const request = await selectRequest(transaction, requestId, true);
        if (!request) return { kind: 'rejected', rejection: 'not-found' };

        const materialized = await materializePendingRequest(
          transaction,
          request.questId,
          request,
          now
        );
        const ownResponse = (await selectResponses(transaction, requestId)).find(
          (candidate) => candidate.workerId === userId
        );
        const [activeAssignment] = await transaction
          .select({ id: questAssignment.id })
          .from(questAssignment)
          .where(
            and(
              eq(questAssignment.questId, request.questId),
              eq(questAssignment.workerId, userId),
              eq(questAssignment.assignmentStatus, 'ASSIGNMENT_ACTIVE')
            )
          )
          .limit(1);
        if (!ownResponse || !activeAssignment) {
          return { kind: 'rejected', rejection: 'not-found' };
        }
        if (currentQuest.questStatus !== questStatus.assigned) {
          return { kind: 'rejected', rejection: 'not-pending' };
        }
        if (materialized.outcome === 'expired') {
          return { kind: 'rejected', rejection: 'expired' };
        }
        if (materialized.request.requestStatus !== 'EDIT_REQUEST_PENDING') {
          if (materialized.request.failureCode === 'EDIT_REQUEST_TIMEOUT') {
            return { kind: 'rejected', rejection: 'expired' };
          }
          return { kind: 'rejected', rejection: 'not-pending' };
        }
        if (ownResponse.decision !== null) {
          return { kind: 'rejected', rejection: 'already-responded' };
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
            await transaction
              .delete(questConditionItem)
              .where(eq(questConditionItem.questId, request.questId));
            await transaction.insert(questConditionItem).values(
              request.proposedCondition.items.map(({ position, text }) => ({
                questId: request.questId,
                position,
                text,
              }))
            );
            await transaction
              .update(quest)
              .set({
                condition: request.proposedCondition.items
                  .map(({ text }) => text)
                  .join('\n')
                  .slice(0, 4000),
                version: sql`${quest.version} + 1`,
                updatedAt: now,
              })
              .where(
                and(eq(quest.id, request.questId), eq(quest.questStatus, questStatus.assigned))
              );
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
        if (!updatedRequest)
          throw new Error(`Quest Edit Request ${requestId} could not be read back`);
        const resource = await projectRequest(transaction, userId, currentQuest, updatedRequest);
        if (!resource) throw new Error(`Quest Edit Request ${requestId} could not be projected`);
        return {
          kind: 'success',
          result: resource,
          resourceType: 'quest-v2-edit-request',
          resourceId: requestId,
        };
      },
      toSnapshot: (result) => result,
      fromSnapshot: requestFromSnapshot,
    });

    if ('outcome' in command) return { outcome: command.outcome };
    if (command.kind === 'success') return { request: command.result };
    return { outcome: command.rejection };
  });
};

export const getQuestV2EditRequest = async (
  userId: string,
  requestId: string,
  now = new Date()
): Promise<QuestV2EditRequestData | undefined> =>
  db.transaction(async (transaction) => {
    const [identity] = await transaction
      .select({ questId: questV2EditRequest.questId })
      .from(questV2EditRequest)
      .where(eq(questV2EditRequest.id, requestId))
      .limit(1);
    if (!identity) return undefined;

    const currentQuest = await selectQuestForEdit(transaction, identity.questId);
    if (!currentQuest) return undefined;
    const request = await selectRequest(transaction, requestId, true);
    if (!request) return undefined;
    const materialized = await materializePendingRequest(
      transaction,
      request.questId,
      request,
      now
    );
    return projectRequest(transaction, userId, currentQuest, materialized.request);
  });

export const expireQuestV2EditRequest = async (
  requestId: string,
  now = new Date()
): Promise<boolean> =>
  db.transaction(async (transaction) => {
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
    const materialized = await materializePendingRequest(
      transaction,
      request.questId,
      request,
      now
    );
    return materialized.outcome === 'expired';
  });

export const pendingQuestV2EditRequestIds = async (limit: number) =>
  db
    .select({ id: questV2EditRequest.id })
    .from(questV2EditRequest)
    .where(eq(questV2EditRequest.requestStatus, 'EDIT_REQUEST_PENDING'))
    .orderBy(asc(questV2EditRequest.expiresAt), asc(questV2EditRequest.id))
    .limit(limit);

export const hasPendingQuestV2EditRequest = async (
  transaction: QuestTransaction,
  questId: string
): Promise<boolean> => {
  const [pending] = await transaction
    .select({ id: questV2EditRequest.id })
    .from(questV2EditRequest)
    .where(
      and(
        eq(questV2EditRequest.questId, questId),
        eq(questV2EditRequest.requestStatus, 'EDIT_REQUEST_PENDING')
      )
    )
    .limit(1);
  return Boolean(pending);
};
