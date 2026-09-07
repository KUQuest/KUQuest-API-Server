import { app } from '@/app';
import { db, sql as postgresSql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { quest, questAssignment, questCandidateApplicationV2 } from '@/database/schema/quest.schema';
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
} from '@/modules/quest';
import type { QuestWorkChatMembershipTransition } from '@/modules/quest/quest-work-chat.contract';
import { createWorkChatMembershipWriter } from '@/modules/work-chat';

import { randomUUID } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

const hirer = {
  id: randomUUID(),
  email: `candidate-v2-hirer-${randomUUID()}@ku.th`,
  firstName: 'Candidate',
  lastName: 'Hirer',
};
const candidate = {
  id: randomUUID(),
  email: `candidate-v2-worker-${randomUUID()}@ku.th`,
  firstName: 'Candidate',
  lastName: 'Worker',
};
const secondCandidate = {
  id: randomUUID(),
  email: `candidate-v2-worker-two-${randomUUID()}@ku.th`,
  firstName: 'Second',
  lastName: 'Candidate',
};
const unrelated = {
  id: randomUUID(),
  email: `candidate-v2-unrelated-${randomUUID()}@ku.th`,
  firstName: 'Unrelated',
  lastName: 'Member',
};
const tagId = randomUUID();
const questIds: string[] = [];
let postgresAvailable = false;
let transitions: QuestWorkChatMembershipTransition[] = [];
let writerFailure: Error | undefined;

type OpenApiOperation = {
  operationId?: string;
  security?: unknown;
  parameters?: Array<{ name?: string; in?: string; required?: boolean }>;
};

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
  const memberId = headers.get('x-member-id') ?? candidate.id;
  const member = [hirer, candidate, secondCandidate, unrelated].find(({ id }) => id === memberId) ?? candidate;
  return { user: member, session: { userId: member.id } } as never;
}) as never);

const request = (
  path: string,
  method = 'GET',
  memberId = candidate.id,
  headers: HeadersInit = {},
  body?: BodyInit,
) => app.handle(new Request(`http://localhost${path}`, {
  method,
  headers: { ...headers, 'x-member-id': memberId },
  body,
}));

const createOpenCandidateQuest = async (overrides: Partial<typeof quest.$inferInsert> = {}) => {
  const id = randomUUID();
  questIds.push(id);
  await db.insert(quest).values({
    id,
    hirerId: hirer.id,
    apiVersion: 'v2',
    title: 'Candidate V2 test Quest',
    condition: 'Complete the work',
    mode: 'CANDIDATE',
    participation: 'SOLO',
    v2Mode: 'CANDIDATE',
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
    console.warn('Skipping Quest Candidate V2 persistence tests: PostgreSQL is unavailable');
    return;
  }
  await db.insert(authUser).values([hirer, candidate, secondCandidate, unrelated]);
  await db.insert(tag).values({ id: tagId, name: 'Candidate V2 test tag' });
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
    inArray(walletIdempotencyKey.principalUserId, [hirer.id, candidate.id, secondCandidate.id, unrelated.id]),
  );
});

afterAll(async () => {
  if (!postgresAvailable) return;
  await db.delete(tag).where(eq(tag.id, tagId));
  await db.delete(authUser).where(inArray(authUser.id, [hirer.id, candidate.id, secondCandidate.id, unrelated.id]));
});

describe('Quest Candidate API v2', () => {
  it('does not accept Candidate application commands after the start boundary', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenCandidateQuest({
      startTime: new Date('2020-01-01T10:00:00.000Z'),
    });
    authenticate();

    const response = await request(
      `/api/v2/quests/${questId}/applications`,
      'POST',
      candidate.id,
      { 'idempotency-key': 'candidate-v2-after-start-create' },
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('QUEST_NOT_OPEN');
    expect(await db.select().from(questCandidateApplicationV2).where(eq(questCandidateApplicationV2.questId, questId))).toHaveLength(0);
  });

  it('does not withdraw or select a Candidate application after the start boundary', async () => {
    if (!postgresAvailable) return;
    authenticate();

    const withdrawQuestId = await createOpenCandidateQuest();
    const withdrawApplication = await request(
      `/api/v2/quests/${withdrawQuestId}/applications`,
      'POST',
      candidate.id,
      { 'idempotency-key': 'candidate-v2-after-start-withdraw-apply' },
    );
    const withdrawApplicationId = (await withdrawApplication.json()).data.id as string;
    await db.update(quest)
      .set({ startTime: new Date('2020-01-01T10:00:00.000Z') })
      .where(eq(quest.id, withdrawQuestId));

    const withdraw = await request(
      `/api/v2/quests/${withdrawQuestId}/applications/${withdrawApplicationId}/withdraw`,
      'POST',
      candidate.id,
      { 'idempotency-key': 'candidate-v2-after-start-withdraw' },
    );
    expect(withdraw.status).toBe(409);
    expect((await withdraw.json()).error.code).toBe('QUEST_NOT_OPEN');

    const selectQuestId = await createOpenCandidateQuest();
    const selectApplication = await request(
      `/api/v2/quests/${selectQuestId}/applications`,
      'POST',
      candidate.id,
      { 'idempotency-key': 'candidate-v2-after-start-select-apply' },
    );
    const selectApplicationId = (await selectApplication.json()).data.id as string;
    await db.update(quest)
      .set({ startTime: new Date('2020-01-01T10:00:00.000Z') })
      .where(eq(quest.id, selectQuestId));

    const select = await request(
      `/api/v2/quests/${selectQuestId}/applications/${selectApplicationId}/select`,
      'POST',
      hirer.id,
      { 'idempotency-key': 'candidate-v2-after-start-select' },
    );
    expect(select.status).toBe(409);
    expect((await select.json()).error.code).toBe('QUEST_NOT_OPEN');
    expect(await db.select().from(questAssignment).where(eq(questAssignment.questId, selectQuestId))).toHaveLength(0);
  });

  it('allows a Prospective Worker to apply and replays the application command', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenCandidateQuest();
    authenticate();

    const first = await request(
      `/api/v2/quests/${questId}/applications`,
      'POST',
      candidate.id,
      { 'idempotency-key': 'candidate-v2-apply-1' },
    );
    expect(first.status).toBe(200);
    const firstBody = await first.json() as {
      data: { id: string; questId: string; memberId: string; state: string; appliedAt: string };
    };
    expect(firstBody.data).toMatchObject({
      questId,
      memberId: candidate.id,
      state: 'APPLICATION_APPLIED',
    });

    const replay = await request(
      `/api/v2/quests/${questId}/applications`,
      'POST',
      candidate.id,
      { 'idempotency-key': 'candidate-v2-apply-1' },
    );
    expect(replay.status).toBe(200);
    expect((await replay.json()).data).toEqual(firstBody.data);

    const applications = await db
      .select()
      .from(questCandidateApplicationV2)
      .where(eq(questCandidateApplicationV2.questId, questId));
    expect(applications).toHaveLength(1);
    expect(applications[0]?.memberId).toBe(candidate.id);
    expect(transitions).toHaveLength(0);

    const assignmentRead = await request(`/api/v2/quests/${questId}/assignments`, 'GET', candidate.id);
    expect(assignmentRead.status).toBe(404);
    expect((await assignmentRead.json()).error.code).toBe('QUEST_NOT_FOUND');
    const mine = await request('/api/v2/assignments/mine', 'GET', candidate.id);
    expect(mine.status).toBe(200);
    expect((await mine.json()).data.items).toHaveLength(0);
  });

  it('lets the owning Hirer list applications and a Candidate read only that Candidate application', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenCandidateQuest();
    authenticate();

    const apply = await request(
      `/api/v2/quests/${questId}/applications`,
      'POST',
      candidate.id,
      { 'idempotency-key': 'candidate-v2-read-apply' },
    );
    expect(apply.status).toBe(200);
    const application = (await apply.json()).data as { id: string };

    const candidateList = await request(`/api/v2/quests/${questId}/applications`, 'GET', candidate.id);
    expect(candidateList.status).toBe(200);
    expect((await candidateList.json()).data.items).toHaveLength(1);

    const candidateRead = await request(
      `/api/v2/quests/${questId}/applications/${application.id}`,
      'GET',
      candidate.id,
    );
    expect(candidateRead.status).toBe(200);
    expect((await candidateRead.json()).data).toMatchObject({
      id: application.id,
      memberId: candidate.id,
      state: 'APPLICATION_APPLIED',
    });

    const hirerList = await request(`/api/v2/quests/${questId}/applications`, 'GET', hirer.id);
    expect(hirerList.status).toBe(200);
    expect((await hirerList.json()).data.items).toHaveLength(1);

    const unrelatedList = await request(`/api/v2/quests/${questId}/applications`, 'GET', unrelated.id);
    expect(unrelatedList.status).toBe(404);
    expect((await unrelatedList.json()).error.code).toBe('QUEST_NOT_FOUND');

    const unrelatedRead = await request(
      `/api/v2/quests/${questId}/applications/${application.id}`,
      'GET',
      unrelated.id,
    );
    expect(unrelatedRead.status).toBe(404);
    expect((await unrelatedRead.json()).error.code).toBe('APPLICATION_NOT_FOUND');
  });

  it('publishes the V2 Candidate application read and write operations in OpenAPI', async () => {
    const response = await request('/openapi/json');
    const document = await response.json() as {
      paths: Record<string, Record<string, OpenApiOperation>>;
    };
    const collection = document.paths['/api/v2/quests/{questId}/applications'];
    const detail = document.paths['/api/v2/quests/{questId}/applications/{applicationId}'];
    const withdraw = document.paths['/api/v2/quests/{questId}/applications/{applicationId}/withdraw']?.post;
    const select = document.paths['/api/v2/quests/{questId}/applications/{applicationId}/select']?.post;
    const create = collection?.post;

    expect(create?.operationId).toBe('createQuestApplicationV2');
    expect(collection?.get?.operationId).toBe('listQuestApplicationsV2');
    expect(detail?.get?.operationId).toBe('getQuestApplicationV2');
    expect(withdraw?.operationId).toBe('withdrawQuestApplicationV2');
    expect(select?.operationId).toBe('selectQuestApplicationV2');

    for (const operation of [create, withdraw, select]) {
      expect(operation?.security).toEqual([{ betterAuthSession: [] }]);
      expect(operation?.parameters).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'idempotency-key',
          in: 'header',
          required: true,
        }),
      ]));
    }
  });

  it('lets a Candidate withdraw once while the Quest is open and replays the withdrawal', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenCandidateQuest();
    authenticate();

    const apply = await request(
      `/api/v2/quests/${questId}/applications`,
      'POST',
      candidate.id,
      { 'idempotency-key': 'candidate-v2-withdraw-apply' },
    );
    const applicationId = (await apply.json()).data.id as string;

    const unauthorized = await request(
      `/api/v2/quests/${questId}/applications/${applicationId}/withdraw`,
      'POST',
      secondCandidate.id,
      { 'idempotency-key': 'candidate-v2-withdraw-unauthorized' },
    );
    expect(unauthorized.status).toBe(404);
    expect((await unauthorized.json()).error.code).toBe('APPLICATION_NOT_FOUND');

    const hirerWithdraw = await request(
      `/api/v2/quests/${questId}/applications/${applicationId}/withdraw`,
      'POST',
      hirer.id,
      { 'idempotency-key': 'candidate-v2-withdraw-hirer' },
    );
    expect(hirerWithdraw.status).toBe(409);
    expect((await hirerWithdraw.json()).error.code).toBe('HIRER_CANNOT_WITHDRAW');

    const missingKey = await request(
      `/api/v2/quests/${questId}/applications/${applicationId}/withdraw`,
      'POST',
      candidate.id,
    );
    expect(missingKey.status).toBe(400);
    expect((await missingKey.json()).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const first = await request(
      `/api/v2/quests/${questId}/applications/${applicationId}/withdraw`,
      'POST',
      candidate.id,
      { 'idempotency-key': 'candidate-v2-withdraw-1' },
    );
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { data: { id: string; state: string } };
    expect(firstBody.data).toMatchObject({ id: applicationId, state: 'APPLICATION_WITHDRAWN' });

    const replay = await request(
      `/api/v2/quests/${questId}/applications/${applicationId}/withdraw`,
      'POST',
      candidate.id,
      { 'idempotency-key': 'candidate-v2-withdraw-1' },
    );
    expect(replay.status).toBe(200);
    expect((await replay.json()).data).toEqual(firstBody.data);

    const duplicate = await request(
      `/api/v2/quests/${questId}/applications/${applicationId}/withdraw`,
      'POST',
      candidate.id,
      { 'idempotency-key': 'candidate-v2-withdraw-2' },
    );
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).error.code).toBe('APPLICATION_NOT_WITHDRAWABLE');

    const [stored] = await db
      .select({ state: questCandidateApplicationV2.state })
      .from(questCandidateApplicationV2)
      .where(eq(questCandidateApplicationV2.id, applicationId));
    expect(stored?.state).toBe('APPLICATION_WITHDRAWN');
    expect(transitions).toHaveLength(0);
  });

  it('lets the owning Hirer select one Candidate and rejects the other applications atomically', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenCandidateQuest();
    authenticate();

    const firstApply = await request(
      `/api/v2/quests/${questId}/applications`,
      'POST',
      candidate.id,
      { 'idempotency-key': 'candidate-v2-select-apply-first' },
    );
    const firstApplicationId = (await firstApply.json()).data.id as string;
    const secondApply = await request(
      `/api/v2/quests/${questId}/applications`,
      'POST',
      secondCandidate.id,
      { 'idempotency-key': 'candidate-v2-select-apply-second' },
    );
    const secondApplicationId = (await secondApply.json()).data.id as string;

    const missingKey = await request(
      `/api/v2/quests/${questId}/applications/${firstApplicationId}/select`,
      'POST',
      hirer.id,
    );
    expect(missingKey.status).toBe(400);
    expect((await missingKey.json()).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const hirerList = await request(`/api/v2/quests/${questId}/applications`, 'GET', hirer.id);
    expect(hirerList.status).toBe(200);
    expect((await hirerList.json()).data.items).toHaveLength(2);

    const first = await request(
      `/api/v2/quests/${questId}/applications/${firstApplicationId}/select`,
      'POST',
      hirer.id,
      { 'idempotency-key': 'candidate-v2-select-1' },
    );
    expect(first.status).toBe(200);
    const firstBody = await first.json() as {
      data: { assignments: Array<{ id: string; workerId: string; state: string; questState: string }>; questState: string };
    };
    expect(firstBody.data.questState).toBe('QUEST_ASSIGNED');
    expect(firstBody.data.assignments).toHaveLength(1);
    expect(firstBody.data.assignments[0]).toMatchObject({
      questId,
      workerId: candidate.id,
      state: 'ASSIGNMENT_ACTIVE',
      questState: 'QUEST_ASSIGNED',
    });

    const replay = await request(
      `/api/v2/quests/${questId}/applications/${firstApplicationId}/select`,
      'POST',
      hirer.id,
      { 'idempotency-key': 'candidate-v2-select-1' },
    );
    expect(replay.status).toBe(200);
    expect((await replay.json()).data).toEqual(firstBody.data);

    const [currentQuest] = await db
      .select({ state: quest.questStatus })
      .from(quest)
      .where(eq(quest.id, questId));
    expect(currentQuest?.state).toBe('QUEST_ASSIGNED');
    const applications = await db
      .select({ id: questCandidateApplicationV2.id, workerId: questCandidateApplicationV2.memberId, state: questCandidateApplicationV2.state })
      .from(questCandidateApplicationV2)
      .where(eq(questCandidateApplicationV2.questId, questId));
    expect(applications).toEqual([
      { id: firstApplicationId, workerId: candidate.id, state: 'APPLICATION_SELECTED' },
      { id: secondApplicationId, workerId: secondCandidate.id, state: 'APPLICATION_REJECTED' },
    ]);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      producer: 'QUEST_CANDIDATE_SELECTION',
      type: 'workersAccepted',
      actorId: hirer.id,
      questId,
    });
    expect(transitions[0]?.type === 'workersAccepted' ? transitions[0].workers[0]?.workerId : undefined).toBe(candidate.id);
  });

  it('allows only one concurrent Hirer selection to win and rejects the losing command', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenCandidateQuest();
    authenticate();

    const firstApply = await request(
      `/api/v2/quests/${questId}/applications`,
      'POST',
      candidate.id,
      { 'idempotency-key': 'candidate-v2-concurrent-apply-first' },
    );
    const firstApplicationId = (await firstApply.json()).data.id as string;
    const secondApply = await request(
      `/api/v2/quests/${questId}/applications`,
      'POST',
      secondCandidate.id,
      { 'idempotency-key': 'candidate-v2-concurrent-apply-second' },
    );
    const secondApplicationId = (await secondApply.json()).data.id as string;

    const responses = await Promise.all([
      request(
        `/api/v2/quests/${questId}/applications/${firstApplicationId}/select`,
        'POST',
        hirer.id,
        { 'idempotency-key': 'candidate-v2-concurrent-select-first' },
      ),
      request(
        `/api/v2/quests/${questId}/applications/${secondApplicationId}/select`,
        'POST',
        hirer.id,
        { 'idempotency-key': 'candidate-v2-concurrent-select-second' },
      ),
    ]);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(1);
    const losingBody = await responses.find((response) => response.status === 409)?.json() as {
      error: { code: string };
    };
    expect(losingBody.error.code).toBe('QUEST_NOT_OPEN');

    const assignments = await db
      .select()
      .from(questCandidateApplicationV2)
      .where(eq(questCandidateApplicationV2.questId, questId));
    expect(assignments.filter(({ state }) => state === 'APPLICATION_SELECTED')).toHaveLength(1);
    expect(transitions).toHaveLength(1);
  });

  it('rejects a changed selection request that reuses an Idempotency-Key', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenCandidateQuest();
    authenticate();

    const firstApply = await request(
      `/api/v2/quests/${questId}/applications`,
      'POST',
      candidate.id,
      { 'idempotency-key': 'candidate-v2-reused-apply-first' },
    );
    const firstApplicationId = (await firstApply.json()).data.id as string;
    const secondApply = await request(
      `/api/v2/quests/${questId}/applications`,
      'POST',
      secondCandidate.id,
      { 'idempotency-key': 'candidate-v2-reused-apply-second' },
    );
    const secondApplicationId = (await secondApply.json()).data.id as string;

    const first = await request(
      `/api/v2/quests/${questId}/applications/${firstApplicationId}/select`,
      'POST',
      hirer.id,
      { 'idempotency-key': 'candidate-v2-reused-select' },
    );
    expect(first.status).toBe(200);

    const changed = await request(
      `/api/v2/quests/${questId}/applications/${secondApplicationId}/select`,
      'POST',
      hirer.id,
      { 'idempotency-key': 'candidate-v2-reused-select' },
    );
    expect(changed.status).toBe(409);
    expect((await changed.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(transitions).toHaveLength(1);
  });

  it('rolls back selection, application statuses, and Quest State when Work Chat fails', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenCandidateQuest();
    authenticate();
    const apply = await request(
      `/api/v2/quests/${questId}/applications`,
      'POST',
      candidate.id,
      { 'idempotency-key': 'candidate-v2-failure-apply' },
    );
    const applicationId = (await apply.json()).data.id as string;
    writerFailure = new Error('chat unavailable');

    const response = await request(
      `/api/v2/quests/${questId}/applications/${applicationId}/select`,
      'POST',
      hirer.id,
      { 'idempotency-key': 'candidate-v2-failure-select' },
    );
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('WORK_CHAT_UNAVAILABLE');

    const [currentQuest] = await db
      .select({ state: quest.questStatus })
      .from(quest)
      .where(eq(quest.id, questId));
    expect(currentQuest?.state).toBe('QUEST_OPEN');
    const [storedApplication] = await db
      .select({ state: questCandidateApplicationV2.state })
      .from(questCandidateApplicationV2)
      .where(eq(questCandidateApplicationV2.id, applicationId));
    expect(storedApplication?.state).toBe('APPLICATION_APPLIED');
    expect(transitions).toHaveLength(1);
  });

  it('creates the Work Conversation and memberships in the selection transaction', async () => {
    if (!postgresAvailable) return;
    configureQuestWorkChatMembershipWriter(createWorkChatMembershipWriter());
    const questId = await createOpenCandidateQuest();
    authenticate();
    const apply = await request(
      `/api/v2/quests/${questId}/applications`,
      'POST',
      candidate.id,
      { 'idempotency-key': 'candidate-v2-production-apply' },
    );
    const applicationId = (await apply.json()).data.id as string;

    const response = await request(
      `/api/v2/quests/${questId}/applications/${applicationId}/select`,
      'POST',
      hirer.id,
      { 'idempotency-key': 'candidate-v2-production-select' },
    );
    expect(response.status).toBe(200);
    const assignmentId = (await response.json()).data.assignments[0].id as string;
    const conversations = await db
      .select({ id: chatConversation.id })
      .from(chatConversation)
      .where(eq(chatConversation.questId, questId));
    expect(conversations).toHaveLength(1);
    const memberships = await db
      .select({ role: chatMembership.role, memberId: chatMembership.memberId, assignmentId: chatMembership.assignmentId })
      .from(chatMembership)
      .where(eq(chatMembership.conversationId, conversations[0]!.id));
    expect(memberships).toHaveLength(2);
    expect(memberships).toContainEqual({ role: 'HIRER', memberId: hirer.id, assignmentId: null });
    expect(memberships).toContainEqual({ role: 'WORKER', memberId: candidate.id, assignmentId });
  });

  it('rejects Hirer, wrong mode, wrong participation, closed, and V1 application commands', async () => {
    if (!postgresAvailable) return;
    authenticate();

    const hirerQuestId = await createOpenCandidateQuest();
    const hirerResponse = await request(
      `/api/v2/quests/${hirerQuestId}/applications`,
      'POST',
      hirer.id,
      { 'idempotency-key': 'candidate-v2-invalid-hirer' },
    );
    expect(hirerResponse.status).toBe(409);
    expect((await hirerResponse.json()).error.code).toBe('HIRER_CANNOT_APPLY');

    const wrongModeQuestId = await createOpenCandidateQuest({ v2Mode: 'FIRST_COME_FIRST_SERVED' });
    const wrongModeResponse = await request(
      `/api/v2/quests/${wrongModeQuestId}/applications`,
      'POST',
      candidate.id,
      { 'idempotency-key': 'candidate-v2-invalid-mode' },
    );
    expect(wrongModeResponse.status).toBe(409);
    expect((await wrongModeResponse.json()).error.code).toBe('QUEST_MODE_NOT_ALLOWED');

    const wrongParticipationQuestId = await createOpenCandidateQuest({
      participation: 'GROUP',
      v2Participation: 'GROUP',
      headcount: 2,
      questFundingTotalSatang: 4000,
    });
    const wrongParticipationResponse = await request(
      `/api/v2/quests/${wrongParticipationQuestId}/applications`,
      'POST',
      candidate.id,
      { 'idempotency-key': 'candidate-v2-invalid-participation' },
    );
    expect(wrongParticipationResponse.status).toBe(409);
    expect((await wrongParticipationResponse.json()).error.code).toBe('QUEST_PARTICIPATION_NOT_ALLOWED');

    const closedQuestId = await createOpenCandidateQuest({ questStatus: 'QUEST_ASSIGNED' });
    const closedResponse = await request(
      `/api/v2/quests/${closedQuestId}/applications`,
      'POST',
      candidate.id,
      { 'idempotency-key': 'candidate-v2-invalid-state' },
    );
    expect(closedResponse.status).toBe(409);
    expect((await closedResponse.json()).error.code).toBe('QUEST_NOT_OPEN');

    const v1QuestId = randomUUID();
    questIds.push(v1QuestId);
    await db.insert(quest).values({
      id: v1QuestId,
      hirerId: hirer.id,
      title: 'Candidate V1 boundary test Quest',
      condition: 'Complete the work',
      mode: 'CANDIDATE',
      participation: 'SOLO',
      questStatus: 'QUEST_OPEN',
      rewardSatang: 1000,
      tagId,
      headcount: 1,
      startTime: new Date('2030-01-01T10:00:00.000Z'),
    });
    const v1Response = await request(
      `/api/v2/quests/${v1QuestId}/applications`,
      'POST',
      candidate.id,
      { 'idempotency-key': 'candidate-v2-v1-boundary' },
    );
    expect(v1Response.status).toBe(404);
    expect((await v1Response.json()).error.code).toBe('QUEST_NOT_FOUND');

    const v2QuestId = await createOpenCandidateQuest();
    const v1ApplyResponse = await request(
      `/api/v1/quests/${v2QuestId}/applications`,
      'POST',
      candidate.id,
      { 'content-type': 'application/json' },
      JSON.stringify({}),
    );
    expect(v1ApplyResponse.status).toBe(404);
    expect((await v1ApplyResponse.json()).error.code).toBe('QUEST_NOT_FOUND');

    const v2ApplyResponse = await request(
      `/api/v2/quests/${v2QuestId}/applications`,
      'POST',
      candidate.id,
      { 'idempotency-key': 'candidate-v2-v1-boundary-apply' },
    );
    const applicationId = (await v2ApplyResponse.json()).data.id as string;

    const v1ListResponse = await request(
      `/api/v1/quests/${v2QuestId}/applications`,
      'GET',
      hirer.id,
    );
    expect(v1ListResponse.status).toBe(404);
    expect((await v1ListResponse.json()).error.code).toBe('QUEST_NOT_FOUND');

    const v1SelectionResponse = await request(
      `/api/v1/quests/${v2QuestId}/applications/${applicationId}/select`,
      'POST',
      hirer.id,
      { 'idempotency-key': 'candidate-v1-boundary-select' },
    );
    expect(v1SelectionResponse.status).toBe(404);
    expect((await v1SelectionResponse.json()).error.code).toBe('QUEST_NOT_FOUND');

    const [v2Quest] = await db
      .select({ state: quest.questStatus })
      .from(quest)
      .where(eq(quest.id, v2QuestId));
    expect(v2Quest?.state).toBe('QUEST_OPEN');
  });

  it('requires the owning Hirer and an applied Candidate for selection', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenCandidateQuest();
    authenticate();
    const apply = await request(
      `/api/v2/quests/${questId}/applications`,
      'POST',
      candidate.id,
      { 'idempotency-key': 'candidate-v2-authorization-apply' },
    );
    const applicationId = (await apply.json()).data.id as string;

    const candidateResponse = await request(
      `/api/v2/quests/${questId}/applications/${applicationId}/select`,
      'POST',
      candidate.id,
      { 'idempotency-key': 'candidate-v2-candidate-select' },
    );
    expect(candidateResponse.status).toBe(409);
    expect((await candidateResponse.json()).error.code).toBe('CANDIDATE_SELECTION_NOT_ALLOWED');

    const unrelatedResponse = await request(
      `/api/v2/quests/${questId}/applications/${applicationId}/select`,
      'POST',
      unrelated.id,
      { 'idempotency-key': 'candidate-v2-unrelated-select' },
    );
    expect(unrelatedResponse.status).toBe(409);
    expect((await unrelatedResponse.json()).error.code).toBe('CANDIDATE_SELECTION_NOT_ALLOWED');

    const hirerResponse = await request(
      `/api/v2/quests/${questId}/applications/${randomUUID()}/select`,
      'POST',
      hirer.id,
      { 'idempotency-key': 'candidate-v2-missing-application' },
    );
    expect(hirerResponse.status).toBe(404);
    expect((await hirerResponse.json()).error.code).toBe('APPLICATION_NOT_FOUND');
  });

  it('rejects a changed application command that reuses an Idempotency-Key', async () => {
    if (!postgresAvailable) return;
    const firstQuestId = await createOpenCandidateQuest();
    const secondQuestId = await createOpenCandidateQuest();
    authenticate();

    const first = await request(
      `/api/v2/quests/${firstQuestId}/applications`,
      'POST',
      candidate.id,
      { 'idempotency-key': 'candidate-v2-reused-application' },
    );
    expect(first.status).toBe(200);
    const changed = await request(
      `/api/v2/quests/${secondQuestId}/applications`,
      'POST',
      candidate.id,
      { 'idempotency-key': 'candidate-v2-reused-application' },
    );
    expect(changed.status).toBe(409);
    expect((await changed.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('replays concurrent apply retries as one Candidate application', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenCandidateQuest();
    authenticate();
    const responses = await Promise.all([
      request(`/api/v2/quests/${questId}/applications`, 'POST', candidate.id, { 'idempotency-key': 'candidate-v2-concurrent-apply' }),
      request(`/api/v2/quests/${questId}/applications`, 'POST', candidate.id, { 'idempotency-key': 'candidate-v2-concurrent-apply' }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(bodies[0].data.id).toBe(bodies[1].data.id);
    expect(await db.select().from(questCandidateApplicationV2).where(eq(questCandidateApplicationV2.questId, questId))).toHaveLength(1);
  });

  it('returns IDEMPOTENCY_KEY_REQUIRED for missing or blank state-changing Candidate commands', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenCandidateQuest();
    const blankQuestId = await createOpenCandidateQuest();
    authenticate();
    const response = await request(`/api/v2/quests/${questId}/applications`, 'POST', candidate.id);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const blank = await request(
      `/api/v2/quests/${blankQuestId}/applications`,
      'POST',
      candidate.id,
      { 'idempotency-key': '   ' },
    );
    expect(blank.status).toBe(400);
    expect((await blank.json()).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('returns IDEMPOTENCY_IN_PROGRESS for an unfinished Candidate application command', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenCandidateQuest();
    const key = 'candidate-v2-in-progress';
    await db.insert(walletIdempotencyKey).values({
      principalUserId: candidate.id,
      operationScope: 'quest.v2.candidate-application.create',
      key,
      requestHash: await hashRequest({
        authenticatedMemberId: candidate.id,
        operation: 'quest.v2.candidate-application.create',
        path: '/api/v2/quests/:questId/applications',
        questId,
        body: {},
      }),
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
    });
    authenticate();

    const response = await request(
      `/api/v2/quests/${questId}/applications`,
      'POST',
      candidate.id,
      { 'idempotency-key': key },
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect(await db.select().from(questCandidateApplicationV2).where(eq(questCandidateApplicationV2.questId, questId))).toHaveLength(0);
  });
});
