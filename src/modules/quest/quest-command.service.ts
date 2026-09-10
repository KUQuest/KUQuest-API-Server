import { questCommand } from '@/database/schema/quest.schema';

import { and, eq } from 'drizzle-orm';

import type { QuestTransaction } from './quest-work-chat.port';

/** Hashes a request body into the 64 lowercase hex characters of a request digest. */
export const sha256Json = async (value: object): Promise<string> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value))
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export type QuestCommandIdentity = {
  principalUserId: string;
  operationScope: string;
  /** The raw Idempotency-Key header value, untrimmed. */
  key: string;
  /** 64 lowercase hex characters, as returned by {@link sha256Json}. */
  requestHash: string;
  questId?: string;
};

export type QuestCommandOutcomeCode =
  | 'idempotency-in-progress'
  | 'idempotency-key-reused'
  | 'idempotency-unavailable'
  | 'invalid-idempotency-key';

/** The work outcome: a business rejection is a recorded, replayable result. */
export type QuestCommandWork<TResult, TRejection> =
  | { kind: 'success'; result: TResult; resourceType?: string; resourceId?: string }
  | { kind: 'rejected'; rejection: TRejection };

export type QuestCommandResult<TResult, TRejection> =
  | { kind: 'success'; result: TResult }
  | { kind: 'rejected'; rejection: TRejection }
  | { outcome: QuestCommandOutcomeCode };

type QuestCommandRecord = {
  id: string;
  requestHash: string;
  resultData: unknown;
  processingStatus: string;
};

type QuestCommandSnapshot =
  { kind: 'success'; result: unknown } | { kind: 'rejected'; rejection: unknown };

const questCommandRecordFields = {
  id: questCommand.id,
  requestHash: questCommand.requestHash,
  resultData: questCommand.resultData,
  processingStatus: questCommand.processingStatus,
};

const questCommandTtlMs = 24 * 60 * 60 * 1000;

const questCommandSnapshotOf = (value: unknown): QuestCommandSnapshot | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const envelope = value as Record<string, unknown>;
  if (envelope.kind === 'success') return { kind: 'success', result: envelope.result };
  if (envelope.kind === 'rejected') return { kind: 'rejected', rejection: envelope.rejection };
  return undefined;
};

const replayQuestCommand = <TResult, TRejection>(
  record: QuestCommandRecord,
  fromSnapshot: (snapshot: unknown) => TResult | undefined
): QuestCommandResult<TResult, TRejection> => {
  if (record.processingStatus === 'PROCESSING') return { outcome: 'idempotency-in-progress' };
  if (record.processingStatus !== 'COMPLETED') return { outcome: 'idempotency-unavailable' };
  const snapshot = questCommandSnapshotOf(record.resultData);
  if (!snapshot) return { outcome: 'idempotency-unavailable' };
  if (snapshot.kind === 'rejected') {
    return { kind: 'rejected', rejection: snapshot.rejection as TRejection };
  }
  const result = fromSnapshot(snapshot.result);
  if (result === undefined) return { outcome: 'idempotency-unavailable' };
  return { kind: 'success', result };
};

/**
 * Records the Quest Command for a Quest API v2 write command, runs the work
 * inside the caller's transaction, and stores the outcome. A retry with the
 * same principal, operation scope, and Idempotency-Key replays the stored
 * outcome instead of running the work again. A business rejection is recorded
 * and completed; no path deletes the Quest Command.
 */
export const runQuestCommand = async <TResult, TRejection>(input: {
  transaction: QuestTransaction;
  identity: QuestCommandIdentity;
  now: Date;
  work: (context: { commandId: string }) => Promise<QuestCommandWork<TResult, TRejection>>;
  toSnapshot: (result: TResult) => unknown;
  fromSnapshot: (snapshot: unknown) => TResult | undefined;
}): Promise<QuestCommandResult<TResult, TRejection>> => {
  const key = input.identity.key.trim();
  if (key.length === 0 || key.length > 200) return { outcome: 'invalid-idempotency-key' };

  const [created] = await input.transaction
    .insert(questCommand)
    .values({
      key,
      questId: input.identity.questId ?? null,
      principalUserId: input.identity.principalUserId,
      operationScope: input.identity.operationScope,
      requestHash: input.identity.requestHash,
      expiresAt: new Date(input.now.getTime() + questCommandTtlMs),
    })
    .onConflictDoNothing()
    .returning(questCommandRecordFields);

  if (!created) {
    const [existing] = await input.transaction
      .select(questCommandRecordFields)
      .from(questCommand)
      .where(
        and(
          eq(questCommand.principalUserId, input.identity.principalUserId),
          eq(questCommand.operationScope, input.identity.operationScope),
          eq(questCommand.key, key)
        )
      )
      .limit(1)
      .for('update');
    if (!existing) return { outcome: 'idempotency-unavailable' };
    if (existing.requestHash !== input.identity.requestHash) {
      return { outcome: 'idempotency-key-reused' };
    }
    return replayQuestCommand(existing, input.fromSnapshot);
  }

  const work = await input.work({ commandId: created.id });
  const completion =
    work.kind === 'success'
      ? {
          resourceType: work.resourceType ?? null,
          resourceId: work.resourceId ?? null,
          resultData: { kind: 'success', result: input.toSnapshot(work.result) },
        }
      : {
          resultData: { kind: 'rejected', rejection: work.rejection },
        };
  await input.transaction
    .update(questCommand)
    .set({ ...completion, processingStatus: 'COMPLETED', completedAt: input.now })
    .where(eq(questCommand.id, created.id));
  return work.kind === 'success'
    ? { kind: 'success', result: work.result }
    : { kind: 'rejected', rejection: work.rejection };
};
