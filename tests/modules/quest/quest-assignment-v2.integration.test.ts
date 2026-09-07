import { app } from '@/app';
import { db, sql as postgresSql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { quest, questAssignment } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { walletIdempotencyKey } from '@/database/schema/wallet.schema';
import {
  chatConversation,
  chatMembership,
  chatMessage,
  chatTransitionCommand,
} from '@/database/schema/work-chat.schema';
import { auth } from '@/modules/auth';
import {
  configureQuestWorkChatMembershipWriter,
  type QuestTransaction,
} from '@/modules/quest/quest-assignment.service';
import type { QuestWorkChatMembershipTransition } from '@/modules/quest/quest-work-chat.contract';
import { createWorkChatMembershipWriter } from '@/modules/work-chat';

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
const thirdWorker = {
  id: randomUUID(),
  email: `assignment-v2-worker-three-${randomUUID()}@ku.th`,
  firstName: 'Third',
  lastName: 'Worker',
};
const tagId = randomUUID();
const productionWriter = createWorkChatMembershipWriter();
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
  const member = [hirer, worker, secondWorker, thirdWorker].find(({ id }) => id === memberId) ?? worker;
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

const createOpenSingleFcfsQuest = (overrides: Partial<typeof quest.$inferInsert> = {}) => createOpenQuest(overrides);

const createOpenGroupFcfsQuest = (overrides: Partial<typeof quest.$inferInsert> = {}) => createOpenQuest({
  participation: 'GROUP',
  v2Participation: 'GROUP',
  headcount: 2,
  questFundingTotalSatang: 4000,
  ...overrides,
});

const hashRequest = async (value: object) => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

beforeAll(async () => {
  try {
    await postgresSql`select 1`;
    postgresAvailable = true;
  } catch {
    console.warn('Skipping Quest Assignment V2 persistence tests: PostgreSQL is unavailable');
    return;
  }
  await db.insert(authUser).values([hirer, worker, secondWorker, thirdWorker]);
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
    const conversations = await db
      .select({ id: chatConversation.id })
      .from(chatConversation)
      .where(inArray(chatConversation.questId, questIds));
    const conversationIds = conversations.map(({ id }) => id);
    if (conversationIds.length > 0) {
      await db.delete(chatMessage).where(inArray(chatMessage.conversationId, conversationIds));
      await db.delete(chatMembership).where(inArray(chatMembership.conversationId, conversationIds));
      await db.delete(chatTransitionCommand).where(inArray(chatTransitionCommand.questId, questIds));
      await db.delete(chatConversation).where(inArray(chatConversation.id, conversationIds));
    }
    await db.delete(quest).where(inArray(quest.id, questIds));
    questIds.splice(0, questIds.length);
  }
  await db.delete(walletIdempotencyKey).where(
    inArray(walletIdempotencyKey.principalUserId, [hirer.id, worker.id, secondWorker.id, thirdWorker.id]),
  );
});

afterAll(async () => {
  if (!postgresAvailable) return;
  await db.delete(tag).where(eq(tag.id, tagId));
  await db.delete(authUser).where(inArray(authUser.id, [hirer.id, worker.id, secondWorker.id, thirdWorker.id]));
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

  it('does not accept a SINGLE FCFS Join after the start boundary', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenSingleFcfsQuest({
      startTime: new Date('2020-01-01T10:00:00.000Z'),
    });
    authenticate();

    const response = await request(
      `/api/v2/quests/${questId}/join`,
      'POST',
      worker.id,
      { 'idempotency-key': 'assignment-v2-single-after-start' },
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('QUEST_NOT_OPEN');
    expect(await db.select().from(questAssignment).where(eq(questAssignment.questId, questId))).toHaveLength(0);
    expect((await db.select({ state: quest.questStatus }).from(quest).where(eq(quest.id, questId)))[0]?.state).toBe('QUEST_OPEN');
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

    await createOpenSingleFcfsQuest({ hirerId: secondWorker.id });
    const otherHirer = await request(`/api/v2/quests/${questId}/assignments`, 'GET', secondWorker.id);
    expect(otherHirer.status).toBe(404);
    expect((await otherHirer.json()).error.code).toBe('QUEST_NOT_FOUND');
  });

  it('accepts GROUP Workers slot-by-slot and assigns the Quest on the final slot', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenGroupFcfsQuest();
    authenticate();

    const first = await request(
      `/api/v2/quests/${questId}/join`,
      'POST',
      worker.id,
      { 'idempotency-key': 'assignment-v2-group-first' },
    );
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { data: { id: string; questState: string; workerId: string } };
    expect(firstBody.data).toMatchObject({
      questState: 'QUEST_OPEN',
      workerId: worker.id,
    });

    const [openQuest] = await db.select({ state: quest.questStatus }).from(quest).where(eq(quest.id, questId));
    expect(openQuest?.state).toBe('QUEST_OPEN');
    expect(await db.select().from(questAssignment).where(eq(questAssignment.questId, questId))).toHaveLength(1);

    const second = await request(
      `/api/v2/quests/${questId}/join`,
      'POST',
      secondWorker.id,
      { 'idempotency-key': 'assignment-v2-group-second' },
    );
    expect(second.status).toBe(200);
    const secondBody = await second.json() as { data: { id: string; questState: string; workerId: string } };
    expect(secondBody.data).toMatchObject({
      questState: 'QUEST_ASSIGNED',
      workerId: secondWorker.id,
    });

    const [assignedQuest] = await db.select({ state: quest.questStatus }).from(quest).where(eq(quest.id, questId));
    expect(assignedQuest?.state).toBe('QUEST_ASSIGNED');
    expect(await db.select().from(questAssignment).where(eq(questAssignment.questId, questId))).toHaveLength(2);
    const acceptedTransitions = transitions.filter(
      (transition): transition is Extract<QuestWorkChatMembershipTransition, { type: 'workersAccepted' }> =>
        transition.type === 'workersAccepted',
    );
    expect(acceptedTransitions).toHaveLength(2);
    expect(acceptedTransitions.map((transition) => transition.workers[0]?.workerId)).toEqual([
      worker.id,
      secondWorker.id,
    ]);
  });

  it('keeps Work Chat command identities separate for Workers using the same Idempotency-Key', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenGroupFcfsQuest();
    configureQuestWorkChatMembershipWriter(productionWriter);
    authenticate();

    const responses = await Promise.all([
      request(`/api/v2/quests/${questId}/join`, 'POST', worker.id, { 'idempotency-key': 'same-group-key' }),
      request(`/api/v2/quests/${questId}/join`, 'POST', secondWorker.id, { 'idempotency-key': 'same-group-key' }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 200]);
    const commands = await db
      .select({ commandId: chatTransitionCommand.commandId })
      .from(chatTransitionCommand)
      .where(eq(chatTransitionCommand.questId, questId));
    expect(commands).toHaveLength(2);
    expect(new Set(commands.map(({ commandId }) => commandId)).size).toBe(2);

    const [conversation] = await db
      .select({ id: chatConversation.id })
      .from(chatConversation)
      .where(eq(chatConversation.questId, questId));
    expect(conversation).toBeDefined();
    const memberships = await db
      .select()
      .from(chatMembership)
      .where(eq(chatMembership.conversationId, conversation!.id));
    expect(memberships).toHaveLength(3);
  });

  it('replays each successful GROUP Join without creating a second Assignment or membership transition', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenGroupFcfsQuest();
    authenticate();

    const first = await request(
      `/api/v2/quests/${questId}/join`,
      'POST',
      worker.id,
      { 'idempotency-key': 'assignment-v2-group-replay-first' },
    );
    const firstId = (await first.json()).data.id as string;
    const firstReplay = await request(
      `/api/v2/quests/${questId}/join`,
      'POST',
      worker.id,
      { 'idempotency-key': 'assignment-v2-group-replay-first' },
    );
    expect(firstReplay.status).toBe(200);
    expect((await firstReplay.json()).data.id).toBe(firstId);

    const second = await request(
      `/api/v2/quests/${questId}/join`,
      'POST',
      secondWorker.id,
      { 'idempotency-key': 'assignment-v2-group-replay-second' },
    );
    const secondId = (await second.json()).data.id as string;
    const secondReplay = await request(
      `/api/v2/quests/${questId}/join`,
      'POST',
      secondWorker.id,
      { 'idempotency-key': 'assignment-v2-group-replay-second' },
    );
    expect(secondReplay.status).toBe(200);
    expect((await secondReplay.json()).data.id).toBe(secondId);

    expect(await db.select().from(questAssignment).where(eq(questAssignment.questId, questId))).toHaveLength(2);
    expect(transitions).toHaveLength(2);
  });

  it('rejects a full GROUP roster and a duplicate Worker without changing the roster', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenGroupFcfsQuest();
    authenticate();

    expect((await request(
      `/api/v2/quests/${questId}/join`,
      'POST',
      worker.id,
      { 'idempotency-key': 'assignment-v2-group-full-first' },
    )).status).toBe(200);
    expect((await request(
      `/api/v2/quests/${questId}/join`,
      'POST',
      secondWorker.id,
      { 'idempotency-key': 'assignment-v2-group-full-second' },
    )).status).toBe(200);

    const duplicate = await request(
      `/api/v2/quests/${questId}/join`,
      'POST',
      worker.id,
      { 'idempotency-key': 'assignment-v2-group-duplicate' },
    );
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).error.code).toBe('ASSIGNMENT_ALREADY_EXISTS');

    const overCapacity = await request(
      `/api/v2/quests/${questId}/join`,
      'POST',
      thirdWorker.id,
      { 'idempotency-key': 'assignment-v2-group-over-capacity' },
    );
    expect(overCapacity.status).toBe(409);
    expect((await overCapacity.json()).error.code).toBe('QUEST_NOT_OPEN');
    expect(await db.select().from(questAssignment).where(eq(questAssignment.questId, questId))).toHaveLength(2);
    expect(transitions).toHaveLength(2);
  });

  it('exposes a GROUP roster only to the owning Hirer and each accepted Worker', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenGroupFcfsQuest();
    authenticate();

    await request(
      `/api/v2/quests/${questId}/join`,
      'POST',
      worker.id,
      { 'idempotency-key': 'assignment-v2-group-read-first' },
    );
    await request(
      `/api/v2/quests/${questId}/join`,
      'POST',
      secondWorker.id,
      { 'idempotency-key': 'assignment-v2-group-read-second' },
    );

    const hirerRead = await request(`/api/v2/quests/${questId}/assignments`, 'GET', hirer.id);
    expect(hirerRead.status).toBe(200);
    expect((await hirerRead.json()).data.items).toHaveLength(2);

    const workerRead = await request(`/api/v2/quests/${questId}/assignments`, 'GET', worker.id);
    expect(workerRead.status).toBe(200);
    expect((await workerRead.json()).data.items).toMatchObject([{ workerId: worker.id }]);

    const secondWorkerRead = await request(`/api/v2/quests/${questId}/assignments`, 'GET', secondWorker.id);
    expect(secondWorkerRead.status).toBe(200);
    expect((await secondWorkerRead.json()).data.items).toMatchObject([{ workerId: secondWorker.id }]);

    const unrelatedRead = await request(`/api/v2/quests/${questId}/assignments`, 'GET', thirdWorker.id);
    expect(unrelatedRead.status).toBe(404);
    expect((await unrelatedRead.json()).error.code).toBe('QUEST_NOT_FOUND');
  });

  it('serializes concurrent GROUP Joins at the published headcount', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenGroupFcfsQuest();
    authenticate();

    const responses = await Promise.all([
      request(`/api/v2/quests/${questId}/join`, 'POST', worker.id, { 'idempotency-key': 'assignment-v2-group-concurrent-1' }),
      request(`/api/v2/quests/${questId}/join`, 'POST', secondWorker.id, { 'idempotency-key': 'assignment-v2-group-concurrent-2' }),
      request(`/api/v2/quests/${questId}/join`, 'POST', thirdWorker.id, { 'idempotency-key': 'assignment-v2-group-concurrent-3' }),
    ]);

    expect(responses.filter((response) => response.status === 200)).toHaveLength(2);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(1);
    const [currentQuest] = await db.select({ state: quest.questStatus }).from(quest).where(eq(quest.id, questId));
    expect(currentQuest?.state).toBe('QUEST_ASSIGNED');
    expect(await db.select().from(questAssignment).where(eq(questAssignment.questId, questId))).toHaveLength(2);
    expect(transitions).toHaveLength(2);
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

  it('rejects duplicate Workers and closed Quests', async () => {
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

  it('returns IDEMPOTENCY_IN_PROGRESS for an unfinished Join command', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenSingleFcfsQuest();
    const key = 'assignment-v2-in-progress';
    await db.insert(walletIdempotencyKey).values({
      principalUserId: worker.id,
      operationScope: 'quest.v2.assignment.join',
      key,
      requestHash: await hashRequest({
        authenticatedMemberId: worker.id,
        operation: 'quest.v2.assignment.join',
        path: '/api/v2/quests/:questId/join',
        questId,
        body: {},
      }),
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
    });
    authenticate();

    const response = await request(
      `/api/v2/quests/${questId}/join`,
      'POST',
      worker.id,
      { 'idempotency-key': key },
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect(await db.select().from(questAssignment).where(eq(questAssignment.questId, questId))).toHaveLength(0);
  });
});
