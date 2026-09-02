import { app } from '@/app';
import { db, sql } from '@/database/client';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';
import {
  quest,
  questAssignment,
  questImage,
  questLocation,
} from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { walletIdempotencyKey } from '@/database/schema/wallet.schema';
import { createStagingTestAuthRoute } from '@/modules/auth';
import { createQuestV2, getQuestV2Detail, type QuestV2CreateInput } from '@/modules/quest';
import { questStatus } from '@/modules/quest/quest.contract';

import { Elysia } from 'elysia';
import { asc, eq, inArray } from 'drizzle-orm';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';

const testEmail = `quest-v2-discovery-${crypto.randomUUID()}@ku.th`;
const testPassword = 'TestStudent1!';
const authTestApp = new Elysia({ name: 'quest-v2-discovery-test-auth' }).use(
  createStagingTestAuthRoute({
    enabled: true,
    deploymentEnv: 'staging',
    email: testEmail,
    password: testPassword,
    firstName: 'Discovery',
    lastName: 'Member',
  }),
);

const getCookieHeader = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');

let memberId = '';
let sessionCookie = '';
const ownerId = crypto.randomUUID();
const adminId = crypto.randomUUID();
const workerIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
const tagId = crypto.randomUUID();
const otherTagId = crypto.randomUUID();
const questIds: string[] = [];
const fileIds: string[] = [];
const fixturePrefix = `Discovery ${crypto.randomUUID()}`;
const tagName = `Discovery Tag ${crypto.randomUUID()}`;
const otherTagName = `Other Discovery Tag ${crypto.randomUUID()}`;

const baseInput: QuestV2CreateInput = {
  title: fixturePrefix,
  description: 'A public discovery description',
  condition: { items: ['First condition', 'Second condition'] },
  mode: 'FIRST_COME_FIRST_SERVED',
  participation: 'SINGLE',
  questFundingTotal: 20,
  headcount: 1,
  startTime: '2030-08-26T10:00:00.000+07:00',
  dueAt: '2030-08-26T12:00:00.000+07:00',
  tagId,
  proofRequired: true,
  locations: [{ label: 'First location' }, { label: 'Second location' }],
};

const createOpenQuest = async (
  owner: string,
  overrides: Partial<QuestV2CreateInput> = {},
  rewardSatang = 1234,
) => {
  const result = await createQuestV2(
    owner,
    { ...baseInput, ...overrides },
    `discovery-create-${crypto.randomUUID()}`,
  );
  if (!('quest' in result)) throw new Error(`Create failed: ${result.outcome}`);
  questIds.push(result.quest.id);
  await db
    .update(quest)
    .set({ questStatus: questStatus.open, rewardSatang })
    .where(eq(quest.id, result.quest.id));
  return result.quest.id;
};

const addActiveWorkers = async (questId: string, workers: string[]) => {
  await db.insert(questAssignment).values(
    workers.map((workerId) => ({
      questId,
      workerId,
      assignmentStatus: 'ASSIGNMENT_ACTIVE',
    })),
  );
};

const getBoard = (query = '') =>
  app.handle(new Request(`http://localhost/api/v2/quests${query}`, {
    headers: { cookie: sessionCookie },
  }));

const getPublicDetail = (questId: string, cookie = sessionCookie) =>
  app.handle(new Request(`http://localhost/api/v2/quests/${questId}/public`, {
    headers: { cookie },
  }));

beforeAll(async () => {
  await sql`select 1`;
  const loginResponse = await authTestApp.handle(
    new Request('http://localhost/api/staging/test-auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: testEmail, password: testPassword }),
    }),
  );
  if (loginResponse.status !== 200) throw new Error(`Test authentication failed: ${loginResponse.status}`);
  memberId = ((await loginResponse.json()) as { user: { id: string } }).user.id;
  sessionCookie = getCookieHeader(loginResponse);

  await db.insert(authUser).values([
    ...workerIds.map((id, index) => ({
      id,
      email: `${id}@ku.th`,
      firstName: 'Worker',
      lastName: String(index + 1),
    })),
    {
      id: ownerId,
      email: `${ownerId}@ku.th`,
      firstName: 'Quest',
      lastName: 'Owner',
    },
  ]);
  await db.insert(authAdmin).values({
    id: adminId,
    email: `${adminId}@admin.kuquest`,
    firstName: 'Discovery',
    lastName: 'Admin',
  });
  await db.insert(tag).values({ id: tagId, name: tagName });
  await db.insert(tag).values({ id: otherTagId, name: otherTagName });
});

beforeEach(async () => {
  if (questIds.length > 0) {
    await db.delete(quest).where(inArray(quest.id, questIds));
    questIds.splice(0, questIds.length);
  }
});

afterAll(async () => {
  if (questIds.length > 0) await db.delete(quest).where(inArray(quest.id, questIds));
  await db.delete(walletIdempotencyKey).where(
    inArray(walletIdempotencyKey.principalUserId, [memberId, ownerId, ...workerIds]),
  );
  if (fileIds.length > 0) await db.delete(file).where(inArray(file.id, fileIds));
  await db.delete(tag).where(eq(tag.id, tagId));
  await db.delete(tag).where(eq(tag.id, otherTagId));
  await db.delete(authAdmin).where(eq(authAdmin.id, adminId));
});

type OpenApiSchema = {
  properties?: Record<string, OpenApiSchema>;
  items?: OpenApiSchema;
  required?: string[];
  format?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  nullable?: boolean;
};

type OpenApiOperation = {
  operationId?: string;
  security?: unknown;
  parameters?: Array<{
    name?: string;
    in?: string;
    required?: boolean;
    schema?: OpenApiSchema;
  }>;
  responses?: Record<string, { content?: Record<string, { schema?: OpenApiSchema }> }>;
};

describe('Quest API v2 discovery contract', () => {
  it.each([
    ['GET', '/api/v2/quests'],
    ['GET', '/api/v2/quests/018f47a7-1c7d-7c98-9a11-690d7e83430c/public'],
  ])('%s %s requires Member authentication', async (method, path) => {
    const response = await app.handle(new Request(`http://localhost${path}`, { method }));

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('UNAUTHORIZED');
  });

  it('documents the Board and Public Quest Detail operations', async () => {
    const response = await app.handle(new Request('http://localhost/openapi/json'));
    const document = (await response.json()) as {
      paths: Record<string, Record<string, OpenApiOperation>>;
    };

    const board = document.paths['/api/v2/quests']?.get;
    expect(board?.operationId).toBe('listQuestBoardV2');
    expect(board?.security).toEqual([{ betterAuthSession: [] }]);
    expect(board?.parameters?.map((parameter) => parameter.name)).toEqual(expect.arrayContaining([
      'q',
      'tagId',
      'mode',
      'participation',
      'minQuestReward',
      'maxQuestReward',
      'maxDurationMinutes',
      'startFrom',
      'startTo',
      'limit',
      'cursor',
    ]));

    const publicDetail = document.paths['/api/v2/quests/{questId}/public']?.get;
    expect(publicDetail?.operationId).toBe('getPublicQuestV2Detail');
    expect(publicDetail?.security).toEqual([{ betterAuthSession: [] }]);
    expect(Object.keys(publicDetail?.responses ?? {})).toEqual(expect.arrayContaining([
      '200',
      '400',
      '401',
      '404',
      '500',
      '503',
    ]));

    const boardData = board?.responses?.['200']?.content?.['application/json']?.schema
      ?.properties?.data;
    expect(boardData?.properties?.items?.items?.properties).toEqual(expect.objectContaining({
      id: expect.any(Object),
      questReward: expect.any(Object),
      activeWorkerCount: expect.any(Object),
    }));
    expect(boardData?.required).toEqual(['items', 'nextCursor']);

    const publicData = publicDetail?.responses?.['200']?.content?.['application/json']?.schema
      ?.properties?.data;
    expect(publicData?.properties?.images?.properties).toBeUndefined();
    expect(publicData?.properties?.condition?.properties).toBeDefined();
  });

  it('lists only eligible v2 Quests across the mode and participation matrix', async () => {
    const singleFcfs = await createOpenQuest(ownerId, {
      title: `${fixturePrefix} Single FCFS`,
      participation: 'SINGLE',
      mode: 'FIRST_COME_FIRST_SERVED',
      headcount: 1,
      startTime: '2030-08-26T10:00:00.000+07:00',
      dueAt: '2030-08-26T12:00:00.000+07:00',
    });
    const fullSingleFcfs = await createOpenQuest(ownerId, {
      title: `${fixturePrefix} Full Single FCFS`,
      participation: 'SINGLE',
      mode: 'FIRST_COME_FIRST_SERVED',
      headcount: 1,
      startTime: '2030-08-26T10:01:00.000+07:00',
      dueAt: '2030-08-26T12:01:00.000+07:00',
    });
    const groupFcfs = await createOpenQuest(ownerId, {
      title: `${fixturePrefix} Group FCFS`,
      participation: 'GROUP',
      mode: 'FIRST_COME_FIRST_SERVED',
      headcount: 3,
      startTime: '2030-08-26T10:02:00.000+07:00',
      dueAt: '2030-08-26T12:02:00.000+07:00',
    });
    const fullGroupFcfs = await createOpenQuest(ownerId, {
      title: `${fixturePrefix} Full Group FCFS`,
      participation: 'GROUP',
      mode: 'FIRST_COME_FIRST_SERVED',
      headcount: 2,
      startTime: '2030-08-26T10:03:00.000+07:00',
      dueAt: '2030-08-26T12:03:00.000+07:00',
    });
    const candidateSingle = await createOpenQuest(ownerId, {
      title: `${fixturePrefix} Candidate Single`,
      participation: 'SINGLE',
      mode: 'CANDIDATE',
      headcount: 1,
      startTime: '2030-08-26T10:04:00.000+07:00',
      dueAt: '2030-08-26T12:04:00.000+07:00',
    });
    const candidateGroup = await createOpenQuest(ownerId, {
      title: `${fixturePrefix} Candidate Group`,
      participation: 'GROUP',
      mode: 'CANDIDATE',
      headcount: 2,
      startTime: '2030-08-26T10:05:00.000+07:00',
      dueAt: '2030-08-26T12:05:00.000+07:00',
    });
    await addActiveWorkers(fullSingleFcfs, [workerIds[0]!]);
    await addActiveWorkers(groupFcfs, [workerIds[0]!]);
    await addActiveWorkers(fullGroupFcfs, workerIds.slice(0, 2));
    await addActiveWorkers(candidateSingle, [workerIds[0]!]);
    await addActiveWorkers(candidateGroup, workerIds.slice(0, 2));

    const ownQuest = await createOpenQuest(memberId, {
      title: `${fixturePrefix} Own Quest`,
    });

    const response = await getBoard(`?q=${encodeURIComponent(fixturePrefix)}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: true;
      data: {
        items: Array<{
          id: string;
          questReward: number;
          activeWorkerCount: number;
          location: string | null;
          startTime: string;
          dueAt: string;
          tag: { id: string; name: string };
        }>;
        nextCursor: string | null;
      };
    };

    const [firstLocation] = await db
      .select({ label: questLocation.label })
      .from(questLocation)
      .where(eq(questLocation.questId, singleFcfs))
      .orderBy(questLocation.id);

    expect(body.data.items.map((item) => item.id)).toEqual([
      singleFcfs,
      groupFcfs,
      candidateSingle,
      candidateGroup,
    ]);
    expect(body.data.items[0]).toMatchObject({
      questReward: 12.34,
      activeWorkerCount: 0,
      location: firstLocation?.label,
      startTime: '2030-08-26T10:00:00.000+07:00',
      dueAt: '2030-08-26T12:00:00.000+07:00',
      tag: { id: tagId, name: tagName },
    });
    expect(body.data.items.some((item) => item.id === ownQuest)).toBe(false);
    expect(body.data.nextCursor).toBeNull();
  });

  it('excludes hidden, closed, expired, and non-joinable Quests and returns an empty page', async () => {
    const hiddenQuest = await createOpenQuest(ownerId, { title: `${fixturePrefix} Hidden` });
    await db.update(quest).set({
      questStatus: questStatus.open,
      hiddenAt: new Date(),
      hiddenByAdminId: adminId,
    }).where(eq(quest.id, hiddenQuest));

    const closedQuest = await createOpenQuest(ownerId, { title: `${fixturePrefix} Closed` });
    await db.update(quest).set({ questStatus: questStatus.assigned }).where(eq(quest.id, closedQuest));

    const expiredQuest = await createOpenQuest(ownerId, { title: `${fixturePrefix} Expired` });
    await db.update(quest).set({
      startTime: new Date('2020-08-26T03:00:00.000Z'),
      dueAt: new Date('2020-08-26T05:00:00.000Z'),
    }).where(eq(quest.id, expiredQuest));

    const fullQuest = await createOpenQuest(ownerId, {
      title: `${fixturePrefix} Full Capacity`,
      participation: 'GROUP',
      headcount: 2,
    });
    await addActiveWorkers(fullQuest, workerIds.slice(0, 2));

    const response = await getBoard(`?q=${encodeURIComponent(fixturePrefix)}`);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ items: [], nextCursor: null });

    const emptyResponse = await getBoard(`?q=${encodeURIComponent(`${fixturePrefix} no match`)}`);
    expect(emptyResponse.status).toBe(200);
    expect((await emptyResponse.json()).data).toEqual({ items: [], nextCursor: null });
  });

  it('returns the separate public projection with ordered Condition and temporary images', async () => {
    const publicQuestId = await createOpenQuest(ownerId, {
      title: `${fixturePrefix} Public Detail`,
      description: 'Only public Quest fields belong in this projection',
      locations: [{ label: 'Public first' }, { label: 'Public second' }],
    });
    const [publicFile] = await db
      .insert(file)
      .values({
        bucket: 'test-bucket',
        objectKey: `quests/v2/${ownerId}/public.png`,
        contentType: 'image/png',
        sizeBytes: 3,
        uploadedByUserId: ownerId,
      })
      .returning({ id: file.id });
    if (!publicFile) throw new Error('Public Quest Image file was not created');
    fileIds.push(publicFile.id);
    await db.insert(questImage).values({
      questId: publicQuestId,
      fileId: publicFile.id,
      position: 0,
    });

    const linkCreatedAt = Date.now();
    const response = await getPublicDetail(publicQuestId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: true;
      data: Record<string, unknown> & {
        condition: { items: Array<{ position: number; text: string }> };
        images: Array<Record<string, unknown>>;
      };
    };
    const urlExpiresAt = Date.parse(String(body.data.images[0]?.urlExpiresAt));
    expect(urlExpiresAt).toBeGreaterThanOrEqual(linkCreatedAt + 15 * 60 * 1000);
    expect(urlExpiresAt).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000);
    expect(body.data).toMatchObject({
      id: publicQuestId,
      title: `${fixturePrefix} Public Detail`,
      description: 'Only public Quest fields belong in this projection',
      tag: { id: tagId, name: tagName },
      state: 'QUEST_OPEN',
      questReward: 12.34,
      activeWorkerCount: 0,
      proofRequired: true,
      hirerName: 'Quest Owner',
      images: [{
        imageId: expect.any(String),
        position: 0,
        url: expect.stringMatching(/^https?:\/\//),
        urlExpiresAt: expect.any(String),
      }],
    });
    expect(body.data.condition.items).toEqual([
      { position: 0, text: 'First condition' },
      { position: 1, text: 'Second condition' },
    ]);
    const expectedLocations = await db
      .select({ label: questLocation.label })
      .from(questLocation)
      .where(eq(questLocation.questId, publicQuestId))
      .orderBy(asc(questLocation.id));
    expect(body.data.locations).toEqual(expectedLocations);
    expect(body.data.images[0]).not.toHaveProperty('fileId');
    expect(body.data).not.toHaveProperty('hirerId');
    expect(body.data).not.toHaveProperty('questFundingTotal');
    expect(body.data).not.toHaveProperty('platformFee');
    expect(body.data).not.toHaveProperty('wallet');
    expect(body.data).not.toHaveProperty('fundingReservation');
    expect(body.data).not.toHaveProperty('candidate');
  });

  it('returns public detail to active Workers even when a Quest is hidden or assigned', async () => {
    const hiddenQuest = await createOpenQuest(ownerId, { title: `${fixturePrefix} Hidden Public` });
    await db.update(quest).set({
      questStatus: questStatus.open,
      hiddenAt: new Date(),
      hiddenByAdminId: adminId,
    }).where(eq(quest.id, hiddenQuest));
    await addActiveWorkers(hiddenQuest, [memberId]);

    const assignedQuest = await createOpenQuest(ownerId, { title: `${fixturePrefix} Assigned Public` });
    await db.update(quest).set({ questStatus: questStatus.assigned }).where(eq(quest.id, assignedQuest));
    await addActiveWorkers(assignedQuest, [memberId]);

    const hiddenResponse = await getPublicDetail(hiddenQuest);
    expect(hiddenResponse.status).toBe(200);
    const hiddenBody = (await hiddenResponse.json()) as { data: Record<string, unknown> };
    expect(hiddenBody.data).toMatchObject({
      id: hiddenQuest,
      state: 'QUEST_OPEN',
    });
    expect(hiddenBody.data).not.toHaveProperty('hiddenAt');
    const ownDetail = await getQuestV2Detail(ownerId, hiddenQuest);
    expect(ownDetail?.hiddenAt).toEqual(expect.any(String));

    const assignedResponse = await getPublicDetail(assignedQuest);
    expect(assignedResponse.status).toBe(200);
    expect((await assignedResponse.json()).data).toMatchObject({
      id: assignedQuest,
      state: 'QUEST_ASSIGNED',
    });
  });

  it('returns QUEST_NOT_FOUND for unreadable Public Quest Detail', async () => {
    const hiddenQuest = await createOpenQuest(ownerId, { title: `${fixturePrefix} Hidden Public` });
    await db.update(quest).set({
      questStatus: questStatus.open,
      hiddenAt: new Date(),
      hiddenByAdminId: adminId,
    }).where(eq(quest.id, hiddenQuest));

    const closedQuest = await createOpenQuest(ownerId, { title: `${fixturePrefix} Closed Public` });
    await db.update(quest).set({ questStatus: questStatus.assigned }).where(eq(quest.id, closedQuest));

    const ownQuest = await createOpenQuest(memberId, { title: `${fixturePrefix} Own Public` });
    const unreadableResponses = await Promise.all(
      [hiddenQuest, closedQuest, ownQuest, crypto.randomUUID()].map(async (questId) => {
        const response = await getPublicDetail(questId);
        return { status: response.status, body: await response.json() };
      }),
    );
    for (const response of unreadableResponses) {
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('QUEST_NOT_FOUND');
    }
  });

  it('applies the approved filters inclusively and paginates with an opaque cursor', async () => {
    const filterPrefix = `${fixturePrefix} Filter`;
    const target = await createOpenQuest(ownerId, {
      title: `${filterPrefix} Target`,
      description: 'Find this description needle',
      mode: 'CANDIDATE',
      participation: 'GROUP',
      headcount: 2,
      tagId,
      startTime: '2030-09-02T10:00:00.000+07:00',
      dueAt: '2030-09-02T11:30:00.000+07:00',
    }, 1250);
    const otherTagQuest = await createOpenQuest(ownerId, {
      title: `${filterPrefix} Other Tag`,
      description: 'Do not find this one',
      tagId: otherTagId,
      startTime: '2030-09-02T09:00:00.000+07:00',
      dueAt: '2030-09-02T10:00:00.000+07:00',
    }, 2000);
    const second = await createOpenQuest(ownerId, {
      title: `${filterPrefix} Second`,
      tagId,
      startTime: '2030-09-02T12:00:00.000+07:00',
      dueAt: '2030-09-02T13:00:00.000+07:00',
    }, 1250);

    const filtered = await getBoard(`?q=${encodeURIComponent('  needle ')}&tagId=${tagId}` +
      '&mode=CANDIDATE&participation=GROUP&minQuestReward=12.50&maxQuestReward=12.50' +
      '&maxDurationMinutes=90&startFrom=2030-09-02T10:00:00.000%2B07:00' +
      '&startTo=2030-09-02T10:00:00.000%2B07:00');
    expect(filtered.status).toBe(200);
    expect((await filtered.json()).data.items.map((item: { id: string }) => item.id)).toEqual([target]);

    const firstPage = await getBoard(`?q=${encodeURIComponent(filterPrefix)}&limit=1`);
    expect(firstPage.status).toBe(200);
    const firstBody = (await firstPage.json()) as {
      data: { items: Array<{ id: string }>; nextCursor: string | null };
    };
    expect(firstBody.data.items).toHaveLength(1);
    expect(firstBody.data.nextCursor).toEqual(expect.any(String));
    expect(firstBody.data.nextCursor).not.toContain('2030');

    const secondPage = await getBoard(
      `?q=${encodeURIComponent(filterPrefix)}&limit=1&cursor=${firstBody.data.nextCursor}`,
    );
    expect(secondPage.status).toBe(200);
    expect((await secondPage.json()).data.items.map((item: { id: string }) => item.id)).toEqual([target]);
    expect(otherTagQuest).not.toBe(target);
    expect(second).not.toBe(target);
  });

  it.each([
    ['reversed reward range', '?minQuestReward=20&maxQuestReward=10'],
    ['reversed start range', '?startFrom=2030-09-03T10:00:00.000%2B07:00&startTo=2030-09-02T10:00:00.000%2B07:00'],
    ['repeated tagId', `?tagId=${tagId}&tagId=${otherTagId}`],
    ['comma-separated tagId', `?tagId=${tagId},${otherTagId}`],
    ['invalid limit', '?limit=51'],
    ['invalid cursor', '?cursor=not-a-cursor'],
    ['more than two reward decimals', '?minQuestReward=1.0000000000000001'],
  ])('rejects %s with 400 VALIDATION', async (_, query) => {
    const response = await getBoard(query);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('VALIDATION');
  });
});
