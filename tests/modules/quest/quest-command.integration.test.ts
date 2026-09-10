import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { questCommand } from '@/database/schema/quest.schema';
import {
  runQuestCommand,
  type QuestCommandResult,
  type QuestCommandWork,
} from '@/modules/quest/quest-command.service';

import { randomUUID } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

const OPERATION_SCOPE = 'quest.v2.command.test';
const now = new Date('2026-09-10T12:00:00.000Z');
const expiry = new Date(now.getTime() + 24 * 60 * 60 * 1000);
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

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
});
