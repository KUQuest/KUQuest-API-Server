import { app } from '@/app';
import { db, sql } from '@/database/client';
import { quest, questAssignment } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { walletIdempotencyKey } from '@/database/schema/wallet.schema';
import { createStagingTestAuthRoute } from '@/modules/auth';
import {
  createQuestV2,
  expireQuestV2EditRequest,
  type QuestV2CreateInput,
} from '@/modules/quest';

import { Elysia } from 'elysia';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

const ownerEmail = `quest-v2-edit-owner-${crypto.randomUUID()}@ku.th`;
const workerEmail = `quest-v2-edit-worker-${crypto.randomUUID()}@ku.th`;
const secondWorkerEmail = `quest-v2-edit-worker-two-${crypto.randomUUID()}@ku.th`;
const password = 'TestStudent1!';

const ownerAuthApp = new Elysia({ name: 'quest-v2-edit-owner-auth' }).use(
  createStagingTestAuthRoute({
    enabled: true,
    deploymentEnv: 'staging',
    email: ownerEmail,
    password,
    firstName: 'Edit',
    lastName: 'Hirer',
  }),
);
const workerAuthApp = new Elysia({ name: 'quest-v2-edit-worker-auth' }).use(
  createStagingTestAuthRoute({
    enabled: true,
    deploymentEnv: 'staging',
    email: workerEmail,
    password,
    firstName: 'Edit',
    lastName: 'Worker',
  }),
);
const secondWorkerAuthApp = new Elysia({ name: 'quest-v2-edit-worker-two-auth' }).use(
  createStagingTestAuthRoute({
    enabled: true,
    deploymentEnv: 'staging',
    email: secondWorkerEmail,
    password,
    firstName: 'Edit',
    lastName: 'Worker Two',
  }),
);

const cookieHeader = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');

const signIn = async (authApp: Elysia, email: string) => {
  const response = await authApp.handle(
    new Request('http://localhost/api/staging/test-auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
  );
  if (response.status !== 200) throw new Error(`Test authentication failed: ${response.status}`);
  const body = (await response.json()) as { user: { id: string } };
  return { id: body.user.id, cookie: cookieHeader(response) };
};

const tagId = crypto.randomUUID();
const questIds: string[] = [];
let owner: { id: string; cookie: string };
let worker: { id: string; cookie: string };
let secondWorker: { id: string; cookie: string };

const baseInput: QuestV2CreateInput = {
  title: 'Assigned Quest for Edit',
  description: 'Quest Edit integration test',
  condition: { items: ['Old requirement'] },
  mode: 'FIRST_COME_FIRST_SERVED',
  participation: 'SINGLE',
  questFundingTotal: 20,
  headcount: 1,
  startTime: '2030-08-26T10:00:00.000+07:00',
  dueAt: '2030-08-26T12:00:00.000+07:00',
  tagId,
  proofRequired: true,
  locations: [],
};

const createAssignedQuest = async (workerIds = [worker.id]) => {
  const input: QuestV2CreateInput = workerIds.length > 1
    ? {
        ...baseInput,
        participation: 'GROUP',
        questFundingTotal: 40,
        headcount: workerIds.length,
      }
    : baseInput;
  const result = await createQuestV2(
    owner.id,
    { ...input, title: `${input.title} ${crypto.randomUUID()}` },
    `quest-v2-edit-create-${crypto.randomUUID()}`,
  );
  if (!('quest' in result)) throw new Error(`Quest creation failed: ${result.outcome}`);
  questIds.push(result.quest.id);

  await db
    .update(quest)
    .set({ questStatus: 'QUEST_ASSIGNED', rewardSatang: 100 })
    .where(eq(quest.id, result.quest.id));
  await db.insert(questAssignment).values(workerIds.map((workerId) => ({
    questId: result.quest.id,
    workerId,
    assignmentStatus: 'ASSIGNMENT_ACTIVE' as const,
  })));
  return result.quest.id;
};

const createEdit = (questId: string, body: unknown, key = `edit-${crypto.randomUUID()}`) =>
  app.handle(
    new Request(`http://localhost/api/v2/quests/${questId}/edit-requests`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': key,
        cookie: owner.cookie,
      },
      body: JSON.stringify(body),
    }),
  );

const readEdit = (requestId: string, cookie: string) =>
  app.handle(
    new Request(`http://localhost/api/v2/quests/edit-requests/${requestId}`, {
      headers: { cookie },
    }),
  );

const respondToEdit = (
  requestId: string,
  body: unknown,
  cookie: string,
  key = `respond-${crypto.randomUUID()}`,
) =>
  app.handle(
    new Request(`http://localhost/api/v2/quests/edit-requests/${requestId}/respond`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': key,
        cookie,
      },
      body: JSON.stringify(body),
    }),
  );

beforeAll(async () => {
  await sql`select 1`;
  owner = await signIn(ownerAuthApp, ownerEmail);
  worker = await signIn(workerAuthApp, workerEmail);
  secondWorker = await signIn(secondWorkerAuthApp, secondWorkerEmail);
  await db.insert(tag).values({ id: tagId, name: 'Quest Edit Tag' });
});

beforeEach(async () => {
  if (questIds.length > 0) {
    await db.delete(quest).where(inArray(quest.id, questIds));
    questIds.splice(0, questIds.length);
  }
});

afterAll(async () => {
  if (questIds.length > 0) await db.delete(quest).where(inArray(quest.id, questIds));
  await db.delete(tag).where(eq(tag.id, tagId));
  await db.delete(walletIdempotencyKey).where(
    inArray(walletIdempotencyKey.principalUserId, [owner.id, worker.id, secondWorker.id]),
  );
});

describe('Quest Edit v2', () => {
  it('publishes the authenticated v2 Quest Edit operations', async () => {
    const response = await app.handle(new Request('http://localhost/openapi/json'));
    const document = (await response.json()) as {
      paths: Record<string, Record<string, {
        operationId?: string;
        security?: unknown;
        responses?: Record<string, unknown>;
      }>>;
    };
    const create = document.paths['/api/v2/quests/{questId}/edit-requests']?.post;
    const read = document.paths['/api/v2/quests/edit-requests/{requestId}']?.get;
    const respond = document.paths['/api/v2/quests/edit-requests/{requestId}/respond']?.post;

    expect(create?.operationId).toBe('createQuestEditRequestV2');
    expect(read?.operationId).toBe('getQuestEditRequestV2');
    expect(respond?.operationId).toBe('respondToQuestEditRequestV2');
    expect(create?.security).toEqual([{ betterAuthSession: [] }]);
    expect(read?.security).toEqual([{ betterAuthSession: [] }]);
    expect(respond?.security).toEqual([{ betterAuthSession: [] }]);
    expect(Object.keys(create?.responses ?? {})).toEqual(
      expect.arrayContaining(['201', '400', '401', '404', '409', '500', '503']),
    );
    expect(Object.keys(read?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '400', '401', '404', '500']),
    );
  });

  it('creates, reads, and applies a complete Condition replacement', async () => {
    const questId = await createAssignedQuest();
    const created = await createEdit(questId, {
      condition: { items: ['  New requirement  ', 'Second requirement'] },
    });

    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      success: true;
      data: {
        requestId: string;
        questId: string;
        status: string;
        previousCondition: { items: Array<{ position: number; text: string }> };
        proposedCondition: { items: Array<{ position: number; text: string }> };
        responseSummary: Record<string, number>;
        expiresAt: string;
      };
    };
    expect(createdBody.data).toMatchObject({
      questId,
      status: 'EDIT_REQUEST_PENDING',
      previousCondition: { items: [{ position: 0, text: 'Old requirement' }] },
      proposedCondition: {
        items: [
          { position: 0, text: 'New requirement' },
          { position: 1, text: 'Second requirement' },
        ],
      },
      responseSummary: {
        totalCount: 1,
        acceptedCount: 0,
        declinedCount: 0,
        pendingCount: 1,
      },
    });
    expect(createdBody.data.expiresAt).toMatch(/Z$/);

    const workerRead = await readEdit(createdBody.data.requestId, worker.cookie);
    expect(workerRead.status).toBe(200);
    const workerBody = (await workerRead.json()) as { data: Record<string, unknown> };
    expect(workerBody.data).toHaveProperty('ownResponse');
    expect(workerBody.data).not.toHaveProperty('responses');

    const responded = await respondToEdit(
      createdBody.data.requestId,
      { decision: 'EDIT_RESPONSE_ACCEPTED' },
      worker.cookie,
    );
    expect(responded.status).toBe(200);
    expect((await responded.json()).data).toMatchObject({
      status: 'EDIT_REQUEST_APPLIED',
      responseSummary: {
        totalCount: 1,
        acceptedCount: 1,
        declinedCount: 0,
        pendingCount: 0,
      },
    });

    const [condition] = await db
      .select({ text: quest.condition })
      .from(quest)
      .where(eq(quest.id, questId));
    expect(condition?.text).toBe('New requirement\nSecond requirement');
  });

  it('fails a request on decline and replays idempotent results', async () => {
    const questId = await createAssignedQuest();
    const body = { condition: { items: ['Declinable requirement'] } };
    const key = `edit-replay-${crypto.randomUUID()}`;
    const created = await createEdit(questId, body, key);
    const createdBody = (await created.json()) as { data: { requestId: string } };

    const replay = await createEdit(questId, body, key);
    expect(replay.status).toBe(201);
    expect((await replay.json()).data.requestId).toBe(createdBody.data.requestId);

    const reused = await createEdit(questId, {
      condition: { items: ['A different requirement'] },
    }, key);
    expect(reused.status).toBe(409);
    expect((await reused.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const duplicate = await createEdit(questId, {
      condition: { items: ['Another requirement'] },
    });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).error.code).toBe('QUEST_EDIT_PENDING');

    const response = await respondToEdit(
      createdBody.data.requestId,
      { decision: 'EDIT_RESPONSE_DECLINED', reason: 'The scope is not clear' },
      worker.cookie,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({
      status: 'EDIT_REQUEST_FAILED',
      failureCode: 'EDIT_REQUEST_DECLINED',
      responseSummary: {
        totalCount: 1,
        acceptedCount: 0,
        declinedCount: 1,
        pendingCount: 0,
      },
    });

    const ownerRead = await readEdit(createdBody.data.requestId, owner.cookie);
    expect((await ownerRead.json()).data.responses).toMatchObject([
      {
        workerId: worker.id,
        decision: 'EDIT_RESPONSE_DECLINED',
        reason: 'The scope is not clear',
      },
    ]);
  });

  it('materializes timeout and returns expired for a late response', async () => {
    const questId = await createAssignedQuest();
    const created = await createEdit(questId, {
      condition: { items: ['Timed out requirement'] },
    });
    const createdBody = (await created.json()) as { data: { requestId: string } };
    const expiredAt = new Date(Date.now() + 11 * 60 * 1000);

    expect(await expireQuestV2EditRequest(createdBody.data.requestId, expiredAt)).toBe(true);

    const ownerRead = await readEdit(createdBody.data.requestId, owner.cookie);
    expect((await ownerRead.json()).data).toMatchObject({
      status: 'EDIT_REQUEST_FAILED',
      failureCode: 'EDIT_REQUEST_TIMEOUT',
    });

    const lateResponse = await respondToEdit(
      createdBody.data.requestId,
      { decision: 'EDIT_RESPONSE_ACCEPTED' },
      worker.cookie,
    );
    expect(lateResponse.status).toBe(409);
    expect((await lateResponse.json()).error.code).toBe('QUEST_EDIT_EXPIRED');

    const nextRequest = await createEdit(questId, {
      condition: { items: ['New request after timeout'] },
    });
    expect(nextRequest.status).toBe(201);
  });

  it('fails immediately when an Active Worker departs and hides the request from that Worker', async () => {
    const questId = await createAssignedQuest();
    const created = await createEdit(questId, {
      condition: { items: ['Departure requirement'] },
    });
    const createdBody = (await created.json()) as { data: { requestId: string } };

    await db
      .update(questAssignment)
      .set({ assignmentStatus: 'ASSIGNMENT_CANCELLED' })
      .where(and(eq(questAssignment.questId, questId), eq(questAssignment.workerId, worker.id)));

    const workerRead = await readEdit(createdBody.data.requestId, worker.cookie);
    expect(workerRead.status).toBe(404);

    const ownerRead = await readEdit(createdBody.data.requestId, owner.cookie);
    expect((await ownerRead.json()).data).toMatchObject({
      status: 'EDIT_REQUEST_FAILED',
      failureCode: 'ACTIVE_WORKER_LEFT',
    });
  });

  it('serializes concurrent Active Worker responses before applying the Condition once', async () => {
    const questId = await createAssignedQuest([worker.id, secondWorker.id]);
    const created = await createEdit(questId, {
      condition: { items: ['Concurrent requirement'] },
    });
    const createdBody = (await created.json()) as { data: { requestId: string } };

    const responses = await Promise.all([
      respondToEdit(
        createdBody.data.requestId,
        { decision: 'EDIT_RESPONSE_ACCEPTED' },
        worker.cookie,
      ),
      respondToEdit(
        createdBody.data.requestId,
        { decision: 'EDIT_RESPONSE_ACCEPTED' },
        secondWorker.cookie,
      ),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 200]);

    const ownerRead = await readEdit(createdBody.data.requestId, owner.cookie);
    expect((await ownerRead.json()).data).toMatchObject({
      status: 'EDIT_REQUEST_APPLIED',
      responseSummary: {
        totalCount: 2,
        acceptedCount: 2,
        declinedCount: 0,
        pendingCount: 0,
      },
    });
    const [condition] = await db
      .select({ text: quest.condition })
      .from(quest)
      .where(eq(quest.id, questId));
    expect(condition?.text).toBe('Concurrent requirement');
  });
});
