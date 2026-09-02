import { app } from '@/app';
import { db, sql as postgresSql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { quest, questAssignment } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { walletIdempotencyKey } from '@/database/schema/wallet.schema';
import { auth } from '@/modules/auth';
import {
  configureQuestWorkChatMembershipWriter,
  type QuestTransaction,
} from '@/modules/quest/quest-assignment.service';
import type { QuestWorkChatMembershipTransition } from '@/modules/quest/quest-work-chat.contract';

import { randomUUID } from 'node:crypto';

import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

const hirer = {
  id: randomUUID(),
  email: `assignment-v2-hirer-${randomUUID()}@ku.th`,
  firstName: 'Assignment',
  lastName: 'Hirer',
};
const worker = {
  id: randomUUID(),
  email: `assignment-v2-worker-${randomUUID()}@ku.th`,
  firstName: 'Assignment',
  lastName: 'Worker',
};
const secondWorker = {
  id: randomUUID(),
  email: `assignment-v2-worker-two-${randomUUID()}@ku.th`,
  firstName: 'Second',
  lastName: 'Worker',
};
const tagId = randomUUID();
const questIds: string[] = [];
let postgresAvailable = false;
let transitions: QuestWorkChatMembershipTransition[] = [];
let writerFailure: Error | undefined;

const successfulWriter = {
  applyQuestTransition: async (
    _transaction: QuestTransaction,
    transition: QuestWorkChatMembershipTransition,
  ) => {
    transitions.push(transition);
    if (writerFailure) throw writerFailure;
    return { conversationId: 'test-conversation', outcome: 'APPLIED' as const };
  },
};

const authenticate = () => spyOn(auth.api, 'getSession').mockImplementation((async ({ headers }: { headers: Headers }) => {
  const memberId = headers.get('x-member-id') ?? worker.id;
  const member = [hirer, worker, secondWorker].find(({ id }) => id === memberId) ?? worker;
  return { user: member, session: { userId: member.id } } as never;
}) as never);

const request = (
  path: string,
  method = 'GET',
  memberId = worker.id,
  headers: HeadersInit = {},
) => app.handle(new Request(`http://localhost${path}`, {
  method,
  headers: { ...headers, 'x-member-id': memberId },
}));

const createOpenQuest = async (overrides: Partial<typeof quest.$inferInsert> = {}) => {
  const id = randomUUID();
  questIds.push(id);
  await db.insert(quest).values({
    id,
    hirerId: hirer.id,
    apiVersion: 'v2',
    title: 'Assignment V2 test Quest',
    condition: 'Complete the work',
    mode: 'NO_CANDIDATE',
    participation: 'SOLO',
    v2Mode: 'FIRST_COME_FIRST_SERVED',
    v2Participation: 'SINGLE',
    questStatus: 'QUEST_OPEN',
    rewardSatang: 1000,
    questFundingTotalSatang: 2000,
    tagId,
    headcount: 1,
    startTime: new Date('2030-01-01T10:00:00.000Z'),
    ...overrides,
  });
  return id;
};

const createOpenSingleFcfsQuest = () => createOpenQuest();

beforeAll(async () => {
  try {
    await postgresSql`select 1`;
    postgresAvailable = true;
  } catch {
    console.warn('Skipping Quest Assignment V2 persistence tests: PostgreSQL is unavailable');
    return;
  }
  await db.insert(authUser).values([hirer, worker, secondWorker]);
  await db.insert(tag).values({ id: tagId, name: 'Assignment V2 test tag' });
});

beforeEach(() => {
  transitions = [];
  writerFailure = undefined;
  configureQuestWorkChatMembershipWriter(successfulWriter);
});

afterEach(async () => {
  configureQuestWorkChatMembershipWriter(undefined);
  mock.restore();
  if (!postgresAvailable) return;
  if (questIds.length > 0) {
    await db.delete(quest).where(inArray(quest.id, questIds));
    questIds.splice(0, questIds.length);
  }
  await db.delete(walletIdempotencyKey).where(
    inArray(walletIdempotencyKey.principalUserId, [hirer.id, worker.id, secondWorker.id]),
  );
});

afterAll(async () => {
  if (!postgresAvailable) return;
  await db.delete(tag).where(eq(tag.id, tagId));
  await db.delete(authUser).where(inArray(authUser.id, [hirer.id, worker.id, secondWorker.id]));
});

describe('Quest Assignment API v2', () => {
  it('validates the Quest id before authentication', async () => {
    const response = await app.handle(new Request('http://localhost/api/v2/quests/not-a-uuid/join', {
      method: 'POST',
    }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('VALIDATION');
  });

  it('requires authentication and publishes the three first-slice operations', async () => {
    if (!postgresAvailable) return;

    const unauthenticated = await app.handle(new Request('http://localhost/api/v2/assignments/mine'));
    expect(unauthenticated.status).toBe(401);

    const document = await (await app.handle(new Request('http://localhost/openapi/json'))).json() as {
      paths: Record<string, Record<string, { operationId?: string; security?: unknown }>>;
    };
    expect(document.paths['/api/v2/assignments/mine']?.get?.operationId).toBe('listMyQuestAssignmentsV2');
    expect(document.paths['/api/v2/quests/{questId}/assignments']?.get?.operationId).toBe('listQuestAssignmentsV2');
    expect(document.paths['/api/v2/quests/{questId}/join']?.post?.operationId).toBe('joinQuestV2');
    expect(document.paths['/api/v2/quests/{questId}/join']?.post?.security).toEqual([{ betterAuthSession: [] }]);
  });

  it('creates one active Assignment, moves a SINGLE Quest to assigned, and replays the command', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenSingleFcfsQuest();
    authenticate();

    const first = await request(
      `/api/v2/quests/${questId}/join`,
      'POST',
      worker.id,
      { 'idempotency-key': 'assignment-v2-command-1' },
    );
    expect(first.status).toBe(200);
    const firstBody = await first.json() as {
      data: {
        id: string;
        questId: string;
        workerId: string;
        state: string;
        questState: string;
      };
    };
    expect(firstBody.data).toMatchObject({
      questId,
      workerId: worker.id,
      state: 'ASSIGNMENT_ACTIVE',
      questState: 'QUEST_ASSIGNED',
    });

    const replay = await request(
      `/api/v2/quests/${questId}/join`,
      'POST',
      worker.id,
      { 'idempotency-key': 'assignment-v2-command-1' },
    );
    expect(replay.status).toBe(200);
    expect((await replay.json()).data.id).toBe(firstBody.data.id);

    const [currentQuest] = await db.select({ state: quest.questStatus }).from(quest).where(eq(quest.id, questId));
    const assignments = await db.select().from(questAssignment).where(eq(questAssignment.questId, questId));
    expect(currentQuest?.state).toBe('QUEST_ASSIGNED');
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.id).toBe(firstBody.data.id);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.producer).toBe('QUEST_ASSIGNMENT_V2');
  });

  it('allows the Hirer to read all active Assignments and a Worker to read only their own Assignment', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenSingleFcfsQuest();
    authenticate();

    const join = await request(
      `/api/v2/quests/${questId}/join`,
      'POST',
      worker.id,
      { 'idempotency-key': 'assignment-v2-read-command' },
    );
    expect(join.status).toBe(200);

    const workerRead = await request(`/api/v2/quests/${questId}/assignments`, 'GET', worker.id);
    expect(workerRead.status).toBe(200);
    expect((await workerRead.json()).data.items).toHaveLength(1);

    const hirerRead = await request(`/api/v2/quests/${questId}/assignments`, 'GET', hirer.id);
    expect(hirerRead.status).toBe(200);
    expect((await hirerRead.json()).data.items).toHaveLength(1);

    const mine = await request('/api/v2/assignments/mine', 'GET', worker.id);
    expect(mine.status).toBe(200);
    expect((await mine.json()).data.items).toHaveLength(1);

    const unrelated = await request(`/api/v2/quests/${questId}/assignments`, 'GET', secondWorker.id);
    expect(unrelated.status).toBe(404);
    expect((await unrelated.json()).error.code).toBe('QUEST_NOT_FOUND');
  });

  it('does not expose a V1 Quest through the V2 Assignment API', async () => {
    if (!postgresAvailable) return;
    const id = randomUUID();
    questIds.push(id);
    await db.insert(quest).values({
      id,
      hirerId: hirer.id,
      title: 'Assignment V1 boundary test Quest',
      condition: 'Complete the work',
      mode: 'NO_CANDIDATE',
      participation: 'SOLO',
      questStatus: 'QUEST_OPEN',
      rewardSatang: 1000,
      tagId,
      headcount: 1,
      startTime: new Date('2030-01-01T10:00:00.000Z'),
    });
    authenticate();

    const response = await request(
      `/api/v2/quests/${id}/join`,
      'POST',
      worker.id,
      { 'idempotency-key': 'assignment-v2-v1-boundary' },
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe('QUEST_NOT_FOUND');
  });

  it('rolls back the Assignment and Quest State when Work Chat membership fails', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenSingleFcfsQuest();
    writerFailure = new Error('chat unavailable');
    authenticate();

    const response = await request(
      `/api/v2/quests/${questId}/join`,
      'POST',
      worker.id,
      { 'idempotency-key': 'assignment-v2-chat-failure' },
    );
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('WORK_CHAT_UNAVAILABLE');

    const [currentQuest] = await db.select({ state: quest.questStatus }).from(quest).where(eq(quest.id, questId));
    const [assignmentCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(questAssignment)
      .where(eq(questAssignment.questId, questId));
    expect(currentQuest?.state).toBe('QUEST_OPEN');
    expect(Number(assignmentCount?.count ?? 0)).toBe(0);
  });

  it('rejects the Hirer and a non-FCFS Quest without creating an Assignment', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenSingleFcfsQuest();
    authenticate();

    const hirerResponse = await request(
      `/api/v2/quests/${questId}/join`,
      'POST',
      hirer.id,
      { 'idempotency-key': 'assignment-v2-hirer' },
    );
    expect(hirerResponse.status).toBe(409);
    expect((await hirerResponse.json()).error.code).toBe('HIRER_CANNOT_JOIN');

    await db.update(quest).set({ v2Mode: 'CANDIDATE' }).where(eq(quest.id, questId));
    const candidateResponse = await request(
      `/api/v2/quests/${questId}/join`,
      'POST',
      worker.id,
      { 'idempotency-key': 'assignment-v2-candidate' },
    );
    expect(candidateResponse.status).toBe(409);
    expect((await candidateResponse.json()).error.code).toBe('QUEST_MODE_NOT_ALLOWED');
  });

  it('rejects duplicate Workers, closed Quests, and GROUP participation in this slice', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenSingleFcfsQuest();
    authenticate();

    const first = await request(
      `/api/v2/quests/${questId}/join`,
      'POST',
      worker.id,
      { 'idempotency-key': 'assignment-v2-duplicate-first' },
    );
    expect(first.status).toBe(200);

    const duplicate = await request(
      `/api/v2/quests/${questId}/join`,
      'POST',
      worker.id,
      { 'idempotency-key': 'assignment-v2-duplicate-second' },
    );
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).error.code).toBe('ASSIGNMENT_ALREADY_EXISTS');

    const closedQuestId = await createOpenSingleFcfsQuest();
    await db.update(quest).set({ questStatus: 'QUEST_ASSIGNED' }).where(eq(quest.id, closedQuestId));
    const closed = await request(
      `/api/v2/quests/${closedQuestId}/join`,
      'POST',
      worker.id,
      { 'idempotency-key': 'assignment-v2-closed' },
    );
    expect(closed.status).toBe(409);
    expect((await closed.json()).error.code).toBe('QUEST_NOT_OPEN');

    const groupQuestId = await createOpenQuest({
      v2Participation: 'GROUP',
      participation: 'GROUP',
      headcount: 2,
      questFundingTotalSatang: 4000,
    });
    const group = await request(
      `/api/v2/quests/${groupQuestId}/join`,
      'POST',
      worker.id,
      { 'idempotency-key': 'assignment-v2-group' },
    );
    expect(group.status).toBe(409);
    expect((await group.json()).error.code).toBe('QUEST_PARTICIPATION_NOT_ALLOWED');
  });

  it('returns IDEMPOTENCY_KEY_REUSED when another request uses the same key', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenSingleFcfsQuest();
    authenticate();

    const first = await request(
      `/api/v2/quests/${questId}/join`,
      'POST',
      worker.id,
      { 'idempotency-key': 'assignment-v2-reused-key' },
    );
    expect(first.status).toBe(200);

    const anotherQuestId = await createOpenSingleFcfsQuest();
    const changedRequest = await request(
      `/api/v2/quests/${anotherQuestId}/join`,
      'POST',
      worker.id,
      { 'idempotency-key': 'assignment-v2-reused-key' },
    );
    expect(changedRequest.status).toBe(409);
    expect((await changedRequest.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});
