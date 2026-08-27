import { app } from '@/app';
import { db, sql as postgresSql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { quest, questAssignment } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { auth } from '@/modules/auth';
import {
  configureQuestWorkChatMembershipWriter,
  type QuestTransaction,
} from '@/modules/quest/quest-assignment.service';

import { randomUUID } from 'node:crypto';

import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

type Worker = { id: string; email: string; firstName: string; lastName: string };

const hirer: Worker = { id: randomUUID(), email: 'join-hirer@ku.th', firstName: 'Join', lastName: 'Hirer' };
const workers = [1, 2, 3].map((number) => ({
  id: randomUUID(),
  email: `join-worker-${number}@ku.th`,
  firstName: 'Join',
  lastName: `Worker ${number}`,
}));
const tagId = randomUUID();
const questIds: string[] = [];
let postgresAvailable = false;
const successfulWorkChatWriter = {
  applyQuestTransition: async () => ({ conversationId: 'test-conversation', outcome: 'APPLIED' as const }),
};

const request = (questId: string, workerId?: string, headers: HeadersInit = {}) => app.handle(new Request(`http://localhost/api/v1/quests/${questId}/join`, {
  method: 'POST',
  headers: workerId === undefined ? headers : { ...headers, 'x-worker-id': workerId },
}));

const authenticate = () => spyOn(auth.api, 'getSession').mockImplementation((async ({ headers }: { headers: Headers }) => {
  const workerId = headers.get('x-worker-id');
  const member = [...workers, hirer].find((candidate) => candidate.id === workerId) ?? workers[0];
  return { user: member, session: { userId: member.id } } as never;
}) as never);

const createOpenQuest = async (overrides: Partial<typeof quest.$inferInsert> = {}) => {
  const id = randomUUID();
  questIds.push(id);
  await db.insert(quest).values({
    id,
    hirerId: hirer.id,
    title: 'Direct join test',
    condition: 'Complete the work',
    mode: 'NO_CANDIDATE',
    participation: 'SOLO',
    questStatus: 'QUEST_OPEN',
    rewardSatang: 500,
    tagId,
    headcount: 1,
    startTime: new Date('2030-01-01T10:00:00.000Z'),
    ...overrides,
  });
  return id;
};

beforeAll(async () => {
  try {
    await postgresSql`select 1`;
    postgresAvailable = true;
  } catch {
    console.warn('Skipping direct-join persistence tests: PostgreSQL is unavailable');
    return;
  }
  await db.insert(authUser).values([hirer, ...workers]);
  await db.insert(tag).values({ id: tagId, name: 'Direct join test tag' });
});

beforeEach(() => {
  configureQuestWorkChatMembershipWriter(successfulWorkChatWriter);
});

afterEach(async () => {
  configureQuestWorkChatMembershipWriter(undefined);
  mock.restore();
  if (postgresAvailable && questIds.length > 0) {
    await db.delete(quest).where(inArray(quest.id, questIds));
    questIds.length = 0;
  }
});

afterAll(async () => {
  if (!postgresAvailable) return;
  await db.delete(tag).where(eq(tag.id, tagId));
  await db.delete(authUser).where(inArray(authUser.id, [hirer.id, ...workers.map(({ id }) => id)]));
});

describe('direct NO_CANDIDATE joins', () => {
  it('validates the Quest id before authentication', async () => {
    const response = await app.handle(new Request('http://localhost/api/v1/quests/not-a-uuid/join', { method: 'POST' }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('VALIDATION');
  });

  it('requires authentication and publishes the documented endpoint', async () => {
    if (!postgresAvailable) return;
    const questId = randomUUID();
    const unauthenticated = await app.handle(new Request(`http://localhost/api/v1/quests/${questId}/join`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'auth-check' },
    }));
    expect(unauthenticated.status).toBe(401);

    const document = await (await app.handle(new Request('http://localhost/openapi/json'))).json() as { paths: Record<string, Record<string, { operationId?: string; security?: unknown; parameters?: Array<{ name?: string; in?: string; required?: boolean; schema?: Record<string, unknown> }> }>> };
    const operation = document.paths['/api/v1/quests/{questId}/join']?.post;
    expect(operation?.operationId).toBe('joinNoCandidateQuest');
    expect(operation?.security).toEqual([{ betterAuthSession: [] }]);
    expect(operation?.parameters).toContainEqual({
      name: 'idempotency-key',
      in: 'header',
      required: true,
      schema: { minLength: 1, maxLength: 200, pattern: '\\S', description: 'Non-blank command identity for replay-safe direct joins', type: 'string' },
    });
  });

  it('rejects absent and whitespace-only Idempotency-Key headers', async () => {
    const absent = await request(randomUUID(), undefined);
    expect(absent.status).toBe(400);
    expect((await absent.json()).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const whitespace = await request(randomUUID(), undefined, { 'Idempotency-Key': '   ' });
    expect(whitespace.status).toBe(400);
    expect((await whitespace.json()).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('creates one Assignment at the HTTP seam and replays an idempotent duplicate', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenQuest();
    authenticate();

    const first = await request(questId, workers[0].id, { 'idempotency-key': 'join-command-1' });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.data.workerId).toBe(workers[0].id);
    expect(firstBody.data.assignmentStatus).toBe('ASSIGNMENT_ACTIVE');
    expect(firstBody.data.questStatus).toBe('QUEST_ASSIGNED');

    const second = await request(questId, workers[0].id, { 'idempotency-key': 'join-command-1' });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.data.id).toBe(firstBody.data.id);
    expect(secondBody.data.questStatus).toBe(firstBody.data.questStatus);

    const ordinaryDuplicate = await request(questId, workers[0].id, { 'idempotency-key': 'join-command-2' });
    expect(ordinaryDuplicate.status).toBe(409);
    expect((await ordinaryDuplicate.json()).error.code).toBe('ASSIGNMENT_ALREADY_EXISTS');

    const workerConflict = await request(questId, workers[1].id, { 'idempotency-key': 'join-command-1' });
    expect(workerConflict.status).toBe(409);
    expect((await workerConflict.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const otherQuestId = await createOpenQuest();
    const questConflict = await request(otherQuestId, workers[0].id, { 'idempotency-key': 'join-command-1' });
    expect(questConflict.status).toBe(409);
    expect((await questConflict.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const [otherCount] = await db.select({ count: sql<number>`count(*)` }).from(questAssignment).where(eq(questAssignment.questId, otherQuestId));
    expect(Number(otherCount?.count ?? 0)).toBe(0);

    const assignments = await db.select().from(questAssignment).where(eq(questAssignment.questId, questId));
    const [current] = await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, questId));
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.assignmentStatus).toBe('ASSIGNMENT_ACTIVE');
    expect(current?.status).toBe('QUEST_ASSIGNED');
  });

  it('serializes concurrent retries of the same command', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenQuest();
    authenticate();

    const responses = await Promise.all([
      request(questId, workers[0].id, { 'Idempotency-Key': 'concurrent-command' }),
      request(questId, workers[0].id, { 'Idempotency-Key': 'concurrent-command' }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(bodies[0].data.id).toBe(bodies[1].data.id);
    const assignments = await db.select().from(questAssignment).where(eq(questAssignment.questId, questId));
    expect(assignments).toHaveLength(1);
  });

  it('serializes concurrent GROUP joins at the HTTP seam', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenQuest({ participation: 'GROUP', headcount: 2 });
    authenticate();

    const responses = await Promise.all([
      request(questId, workers[0].id, { 'Idempotency-Key': 'group-join-1' }),
      request(questId, workers[1].id, { 'Idempotency-Key': 'group-join-2' }),
      request(questId, workers[2].id, { 'Idempotency-Key': 'group-join-3' }),
    ]);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(2);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(1);

    const [current] = await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, questId));
    const assignments = await db.select().from(questAssignment).where(eq(questAssignment.questId, questId));
    expect(current?.status).toBe('QUEST_ASSIGNED');
    expect(assignments).toHaveLength(2);
  });

  it('rejects the Hirer and non-direct or closed Quests', async () => {
    if (!postgresAvailable) return;
    const ownQuest = await createOpenQuest();
    authenticate();
    expect((await request(ownQuest, hirer.id, { 'Idempotency-Key': 'hirer-join' })).status).toBe(409);

    const candidateQuest = await createOpenQuest({ mode: 'CANDIDATE' });
    expect((await request(candidateQuest, workers[0].id, { 'Idempotency-Key': 'candidate-join' })).status).toBe(409);

    const closedQuest = await createOpenQuest({ questStatus: 'QUEST_CANCELLED', cancelledAt: new Date() });
    expect((await request(closedQuest, workers[0].id, { 'Idempotency-Key': 'closed-join' })).status).toBe(409);
  });

  it('rolls back Quest and Assignment writes when Work Chat rejects the transition', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenQuest();
    authenticate();
    const apply = mock(async (_transaction: QuestTransaction, _transition: unknown) => {
      throw new Error('chat unavailable');
    });
    configureQuestWorkChatMembershipWriter({ applyQuestTransition: apply });

    const response = await request(questId, workers[0].id, { 'idempotency-key': 'join-command-fails' });
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('WORK_CHAT_UNAVAILABLE');

    configureQuestWorkChatMembershipWriter(successfulWorkChatWriter);
    const retry = await request(questId, workers[0].id, { 'idempotency-key': 'join-command-fails' });
    expect(retry.status).toBe(200);

    const [current] = await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, questId));
    const assignments = await db.select().from(questAssignment).where(and(eq(questAssignment.questId, questId), eq(questAssignment.assignmentStatus, 'ASSIGNMENT_ACTIVE')));
    expect(current?.status).toBe('QUEST_ASSIGNED');
    expect(assignments).toHaveLength(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
