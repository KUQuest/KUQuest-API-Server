import type { AuthedContext } from '@/modules/auth';
import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { questCommand } from '@/database/schema/quest.schema';
import {
  completeQuestCommand,
  findOpenQuestCommandPayloads,
  openQuestCommand,
  parkQuestCommandPayload,
  runQuestCommand,
  type QuestCommandResult,
  type QuestCommandWork,
} from '@/modules/quest/quest-command.service';
import { requireQuestCommandId } from '@/modules/quest/quest-command.controller';

import { randomUUID } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

const OPERATION_SCOPE = 'quest.v2.command.test';
const now = new Date('2026-09-10T12:00:00.000Z');
const expiry = new Date(now.getTime() + 24 * 60 * 60 * 1000);
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const WORKER_NOW_A = new Date(now.getTime() + 60_000);
const WORKER_NOW_B = new Date(now.getTime() + 120_000);
const WORKER_EXPIRY_A = new Date(WORKER_NOW_A.getTime() + 24 * 60 * 60 * 1000);
// Distinct per call, so each test only sees its own rows in find results.
const workerScope = () => `worker-test-${randomUUID()}`;

const principal = {
  id: randomUUID(),
  email: `quest-command-principal-${randomUUID()}@ku.th`,
  firstName: 'Quest',
  lastName: 'Commander',
};
const secondPrincipal = {
  id: randomUUID(),
  email: `quest-command-second-${randomUUID()}@ku.th`,
  firstName: 'Second',
  lastName: 'Commander',
};
let postgresAvailable = false;
let schemaAvailable = false;

beforeAll(async () => {
  try {
    await sql`select 1`;
    postgresAvailable = true;
    const [tables] = await sql<{ command: string | null }[]>`
      select to_regclass('public.quest_command') as command
    `;
    schemaAvailable = tables?.command !== null;
  } catch {
    console.warn('Skipping Quest Command tests: PostgreSQL is unavailable');
    return;
  }
  if (!schemaAvailable) {
    console.warn('Skipping Quest Command tests: quest_command migration is not applied');
    return;
  }
  await db.insert(authUser).values([principal, secondPrincipal]);
});

afterAll(async () => {
  if (!postgresAvailable || !schemaAvailable) return;
  const principalIds = [principal.id, secondPrincipal.id];
  await db.delete(questCommand).where(inArray(questCommand.principalUserId, principalIds));
  await db.delete(authUser).where(inArray(authUser.id, principalIds));
});

const runCommand = async <TResult, TRejection>(input: {
  principalUserId: string;
  key: string;
  requestHash?: string;
  work: () => Promise<QuestCommandWork<TResult, TRejection>>;
  fromSnapshot?: (snapshot: unknown) => TResult | undefined;
}): Promise<QuestCommandResult<TResult, TRejection>> =>
  db.transaction((transaction) =>
    runQuestCommand({
      transaction,
      identity: {
        principalUserId: input.principalUserId,
        operationScope: OPERATION_SCOPE,
        key: input.key,
        requestHash: input.requestHash ?? HASH_A,
      },
      now,
      work: input.work,
      toSnapshot: (result) => result,
      fromSnapshot: input.fromSnapshot ?? ((snapshot) => snapshot as TResult),
    })
  );

const successfulWork = (result: unknown) => async () => ({
  kind: 'success' as const,
  result,
  resourceType: 'quest-v2-test-resource',
  resourceId: randomUUID(),
});

const answerFromSnapshot = (snapshot: unknown) =>
  typeof snapshot === 'object' && snapshot !== null && 'answer' in snapshot
    ? (snapshot as { answer: number })
    : undefined;

describe('Quest Command', () => {
  it('runs the work once and replays the stored result on retry', async () => {
    if (!postgresAvailable || !schemaAvailable) return;
    const key = `command-${randomUUID()}`;
    let runs = 0;
    const work = async () => {
      runs += 1;
      return {
        kind: 'success' as const,
        result: { answer: 42 },
        resourceType: 'quest-v2-test-resource',
        resourceId: randomUUID(),
      };
    };
    const first = await runCommand({
      principalUserId: principal.id,
      key,
      work,
      fromSnapshot: answerFromSnapshot,
    });
    expect(first).toEqual({ kind: 'success', result: { answer: 42 } });
    expect(runs).toBe(1);
    const retry = await runCommand({
      principalUserId: principal.id,
      key,
      work,
      fromSnapshot: answerFromSnapshot,
    });
    expect(retry).toEqual({ kind: 'success', result: { answer: 42 } });
    expect(runs).toBe(1);
  });

  it('reports in-progress while the first command is still PROCESSING', async () => {
    if (!postgresAvailable || !schemaAvailable) return;
    const key = `command-${randomUUID()}`;
    await db.insert(questCommand).values({
      key,
      principalUserId: principal.id,
      operationScope: OPERATION_SCOPE,
      requestHash: HASH_A,
      expiresAt: expiry,
    });
    let runs = 0;
    const result = await runCommand({
      principalUserId: principal.id,
      key,
      work: async () => {
        runs += 1;
        return { kind: 'success' as const, result: { answer: 1 } };
      },
    });
    expect(result).toEqual({ outcome: 'idempotency-in-progress' });
    expect(runs).toBe(0);
  });

  it('reports reuse when the same key carries a different request digest', async () => {
    if (!postgresAvailable || !schemaAvailable) return;
    const key = `command-${randomUUID()}`;
    await runCommand({
      principalUserId: principal.id,
      key,
      requestHash: HASH_A,
      work: successfulWork({ answer: 1 }),
    });
    const retry = await runCommand({
      principalUserId: principal.id,
      key,
      requestHash: HASH_B,
      work: successfulWork({ answer: 2 }),
    });
    expect(retry).toEqual({ outcome: 'idempotency-key-reused' });
  });

  it('reports unavailable when a completed result cannot be rebuilt', async () => {
    if (!postgresAvailable || !schemaAvailable) return;
    const key = `command-${randomUUID()}`;
    await runCommand({
      principalUserId: principal.id,
      key,
      work: successfulWork({ answer: 42 }),
      fromSnapshot: answerFromSnapshot,
    });
    await db
      .update(questCommand)
      .set({ resultData: { corrupted: true } })
      .where(eq(questCommand.key, key));
    const retry = await runCommand({
      principalUserId: principal.id,
      key,
      work: successfulWork({ answer: 42 }),
      fromSnapshot: answerFromSnapshot,
    });
    expect(retry).toEqual({ outcome: 'idempotency-unavailable' });
  });

  it('refuses empty and over-length keys with one invalid code', async () => {
    if (!postgresAvailable || !schemaAvailable) return;
    for (const key of ['', '   ', 'k'.repeat(201)]) {
      const result = await runCommand({
        principalUserId: principal.id,
        key,
        work: successfulWork({ answer: 1 }),
      });
      expect(result).toEqual({ outcome: 'invalid-idempotency-key' });
    }
  });

  it('records a business rejection, keeps the row, and replays the rejection', async () => {
    if (!postgresAvailable || !schemaAvailable) return;
    const key = `command-${randomUUID()}`;
    const rejection = { code: 'QUEST_FULL' };
    let runs = 0;
    const work = async () => {
      runs += 1;
      return { kind: 'rejected' as const, rejection };
    };
    const first = await runCommand({ principalUserId: principal.id, key, work });
    expect(first).toEqual({ kind: 'rejected', rejection });
    expect(runs).toBe(1);
    const [row] = await db.select().from(questCommand).where(eq(questCommand.key, key));
    expect(row.processingStatus).toBe('COMPLETED');
    expect(row.completedAt).toEqual(now);
    expect(row.expiresAt).toEqual(expiry);
    expect(row.resourceId).toBeNull();
    const retry = await runCommand({ principalUserId: principal.id, key, work });
    expect(retry).toEqual({ kind: 'rejected', rejection });
    expect(runs).toBe(1);
  });

  it('keeps separate Quest Commands for two principals using the same key', async () => {
    if (!postgresAvailable || !schemaAvailable) return;
    const key = `command-${randomUUID()}`;
    const first = await runCommand({
      principalUserId: principal.id,
      key,
      work: successfulWork('first'),
    });
    const second = await runCommand({
      principalUserId: secondPrincipal.id,
      key,
      work: successfulWork('second'),
    });
    expect(first).toEqual({ kind: 'success', result: 'first' });
    expect(second).toEqual({ kind: 'success', result: 'second' });
    const rows = await db
      .select({ id: questCommand.id })
      .from(questCommand)
      .where(eq(questCommand.key, key));
    expect(rows).toHaveLength(2);
  });

  it('opens a worker command that stays PROCESSING and finds it for its scope', async () => {
    if (!postgresAvailable || !schemaAvailable) return;
    const operationScope = workerScope();
    const payload = { cleanup: { objects: [{ bucket: 'quest-proof', objectKey: 'a/b' }] } };
    const id = await openQuestCommand({
      executor: db,
      identity: {
        principalUserId: principal.id,
        operationScope,
        key: `worker-${randomUUID()}`,
        requestHash: HASH_A,
      },
      payload,
      now,
    });
    const [row] = await db.select().from(questCommand).where(eq(questCommand.id, id));
    expect(row.processingStatus).toBe('PROCESSING');
    expect(row.completedAt).toBeNull();
    expect(row.resultData).toEqual(payload);
    const found = await findOpenQuestCommandPayloads({ executor: db, operationScope, limit: 100 });
    expect(found).toEqual([{ id, principalUserId: principal.id, questId: null, payload }]);
  });

  it('completes a worker command with the injected now and keeps the row', async () => {
    if (!postgresAvailable || !schemaAvailable) return;
    const id = await openQuestCommand({
      executor: db,
      identity: {
        principalUserId: principal.id,
        operationScope: workerScope(),
        key: `worker-${randomUUID()}`,
        requestHash: HASH_A,
      },
      payload: { cleanup: { objects: [{ bucket: 'b', objectKey: 'k' }] } },
      now,
    });
    const finalPayload = { cleanup: { objects: [] } };
    expect(
      await completeQuestCommand({ executor: db, id, payload: finalPayload, now: WORKER_NOW_A })
    ).toBe(true);
    const [row] = await db.select().from(questCommand).where(eq(questCommand.id, id));
    expect(row.processingStatus).toBe('COMPLETED');
    expect(row.completedAt).toEqual(WORKER_NOW_A);
    expect(row.resultData).toEqual(finalPayload);
  });

  it('keeps the first completion when a second completion loses the race', async () => {
    if (!postgresAvailable || !schemaAvailable) return;
    const id = await openQuestCommand({
      executor: db,
      identity: {
        principalUserId: principal.id,
        operationScope: workerScope(),
        key: `worker-${randomUUID()}`,
        requestHash: HASH_A,
      },
      payload: { cleanup: { objects: [] } },
      now,
    });
    const firstPayload = { cleanup: { objects: [{ bucket: 'b', objectKey: 'first' }] } };
    expect(
      await completeQuestCommand({ executor: db, id, payload: firstPayload, now: WORKER_NOW_A })
    ).toBe(true);
    expect(
      await completeQuestCommand({
        executor: db,
        id,
        payload: { cleanup: { objects: [{ bucket: 'b', objectKey: 'second' }] } },
        now: WORKER_NOW_B,
      })
    ).toBe(false);
    const [row] = await db.select().from(questCommand).where(eq(questCommand.id, id));
    expect(row.resultData).toEqual(firstPayload);
    expect(row.completedAt).toEqual(WORKER_NOW_A);
  });

  it('finds only open commands of the operation scope that carry a payload', async () => {
    if (!postgresAvailable || !schemaAvailable) return;
    const operationScope = workerScope();
    const payload = { cleanup: { objects: [] } };
    const openWorker = (key: string) =>
      openQuestCommand({
        executor: db,
        identity: { principalUserId: principal.id, operationScope, key, requestHash: HASH_A },
        payload,
        now,
      });
    const keptId = await openWorker(`worker-${randomUUID()}`);
    const otherId = await openWorker(`worker-${randomUUID()}`);
    const completedId = await openWorker(`worker-${randomUUID()}`);
    await completeQuestCommand({ executor: db, id: completedId, payload, now: WORKER_NOW_A });
    await openQuestCommand({
      executor: db,
      identity: {
        principalUserId: principal.id,
        operationScope: workerScope(),
        key: `worker-${randomUUID()}`,
        requestHash: HASH_A,
      },
      payload,
      now,
    });
    await db.insert(questCommand).values({
      key: `worker-${randomUUID()}`,
      principalUserId: principal.id,
      operationScope,
      requestHash: HASH_A,
      expiresAt: expiry,
    });
    const found = await findOpenQuestCommandPayloads({ executor: db, operationScope, limit: 100 });
    expect(found.map(({ id }) => id).sort()).toEqual([keptId, otherId].sort());
    expect(found.map(({ payload: carried }) => carried)).toEqual([payload, payload]);
    expect(
      (await findOpenQuestCommandPayloads({ executor: db, operationScope, limit: 1 })).length
    ).toBe(1);
  });

  it('parks a payload on an open command and reports failure without a match', async () => {
    if (!postgresAvailable || !schemaAvailable) return;
    const identity = {
      principalUserId: principal.id,
      operationScope: workerScope(),
      key: `worker-${randomUUID()}`,
      requestHash: HASH_A,
    };
    const id = await openQuestCommand({
      executor: db,
      identity,
      payload: { cleanup: { objects: [] } },
      now,
    });
    const manifest = { cleanup: { objects: [{ bucket: 'b', objectKey: 'parked' }] } };
    const parked = await db.transaction((transaction) =>
      parkQuestCommandPayload({
        executor: transaction,
        identity,
        payload: manifest,
        now: WORKER_NOW_A,
      })
    );
    expect(parked).toBe(id);
    const [row] = await db.select().from(questCommand).where(eq(questCommand.id, id));
    expect(row.resultData).toEqual(manifest);
    expect(row.processingStatus).toBe('PROCESSING');
    expect(row.completedAt).toBeNull();
    expect(row.expiresAt).toEqual(WORKER_EXPIRY_A);
    expect(
      await parkQuestCommandPayload({
        executor: db,
        identity: { ...identity, requestHash: HASH_B },
        payload: manifest,
        now,
      })
    ).toBeUndefined();
  });

  it('requireQuestCommandId validates header presence and rejects missing or blank keys', () => {
    type ContextSet = AuthedContext['set'];
    const set = { status: 200 } as unknown as ContextSet;
    const missing = requireQuestCommandId(undefined, set);
    expect(set.status).toBe(400);
    expect(missing).toEqual({
      success: false,
      error: {
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'The Idempotency-Key header is required',
      },
    });

    const blankRequest = new Request('http://localhost', {
      headers: { 'idempotency-key': '   ' },
    });
    set.status = 200;
    const blank = requireQuestCommandId(blankRequest, set);
    expect(set.status).toBe(400);
    expect(blank).toEqual({
      success: false,
      error: {
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'The Idempotency-Key header is required',
      },
    });

    const validRequest = new Request('http://localhost', {
      headers: { 'idempotency-key': '  valid-key  ' },
    });
    set.status = 200;
    const valid = requireQuestCommandId(validRequest, set);
    expect(set.status).toBe(200);
    expect(valid).toBe('valid-key');
  });
});
