import { app } from '@/app';
import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import {
  quest,
  questConditionItem,
} from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { walletIdempotencyKey } from '@/database/schema/wallet.schema';
import { createStagingTestAuthRoute } from '@/modules/auth';
import { listOwnQuests } from '@/modules/quest/quest.service';
import {
  createQuestV2,
  getQuestV2Detail,
  listOwnQuestV2,
  type QuestV2CreateInput,
} from '@/modules/quest';

import { randomUUID } from 'node:crypto';

import { Elysia } from 'elysia';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

const testEmail = `quest-v2-${randomUUID()}@ku.th`;
const testPassword = 'TestStudent1!';
const authTestApp = new Elysia({ name: 'quest-v2-test-auth' }).use(
  createStagingTestAuthRoute({
    enabled: true,
    deploymentEnv: 'staging',
    email: testEmail,
    password: testPassword,
    firstName: 'Quest v2',
    lastName: 'Hirer',
  }),
);

const getCookieHeader = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');

let hirerId = '';
let sessionCookie = '';
const otherMemberId = randomUUID();
const tagId = randomUUID();
let questIds: string[] = [];

const baseInput: QuestV2CreateInput = {
  title: '  Design a poster  ',
  description: '  A short description  ',
  condition: { items: ['  Use the KUQuest brand  ', 'Return an editable file'] },
  mode: 'FIRST_COME_FIRST_SERVED',
  participation: 'SINGLE',
  questFundingTotal: 1.03,
  headcount: 1,
  startTime: '2030-08-26T10:00:00.000+07:00',
  dueAt: '2030-08-26T12:00:00.000+07:00',
  tagId,
  proofRequired: false,
  locations: [{ label: '  Online  ' }],
};

const postQuest = (body: unknown, key = `quest-v2-http-${randomUUID()}`) =>
  app.handle(
    new Request('http://localhost/api/v2/quests', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': key,
        cookie: sessionCookie,
      },
      body: JSON.stringify(body),
    }),
  );

const getQuest = (questId: string) =>
  app.handle(
    new Request(`http://localhost/api/v2/quests/${questId}`, {
      headers: { cookie: sessionCookie },
    }),
  );

beforeAll(async () => {
  await sql`select 1`;
  const loginResponse = await authTestApp.handle(
    new Request('http://localhost/api/staging/test-auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: testEmail, password: testPassword }),
    }),
  );
  if (loginResponse.status !== 200) {
    throw new Error(`Quest v2 test authentication failed: ${loginResponse.status}`);
  }

  const loginBody = (await loginResponse.json()) as { user: { id: string } };
  hirerId = loginBody.user.id;
  sessionCookie = getCookieHeader(loginResponse);

  await db.insert(authUser).values({
    id: otherMemberId,
    email: `${otherMemberId}@ku.th`,
    firstName: 'v2',
    lastName: 'Member',
  });
  await db.insert(tag).values({ id: tagId, name: `v2 Design ${tagId}` });
});

beforeEach(async () => {
  await db.delete(walletIdempotencyKey).where(
    eq(walletIdempotencyKey.principalUserId, hirerId),
  );
  await db.delete(walletIdempotencyKey).where(
    eq(walletIdempotencyKey.principalUserId, otherMemberId),
  );
  if (questIds.length > 0) {
    await db.delete(quest).where(inArray(quest.id, questIds));
    questIds = [];
  }
});

afterAll(async () => {
  await db.delete(walletIdempotencyKey).where(
    eq(walletIdempotencyKey.principalUserId, hirerId),
  );
  await db.delete(walletIdempotencyKey).where(
    eq(walletIdempotencyKey.principalUserId, otherMemberId),
  );
  await db.delete(quest).where(inArray(quest.id, questIds));
  await db.delete(tag).where(eq(tag.id, tagId));
  await db.delete(authUser).where(eq(authUser.id, otherMemberId));
});

describe('Quest API v2 persistence', () => {
  it('creates, replays, and reads a canonical Quest Draft', async () => {
    const first = await createQuestV2(hirerId, baseInput, 'v2-create-1');
    if (!('quest' in first)) throw new Error(`Create failed: ${first.outcome}`);
    questIds.push(first.quest.id);

    expect(first.quest).toMatchObject({
      title: 'Design a poster',
      description: 'A short description',
      condition: {
        items: [
          { position: 0, text: 'Use the KUQuest brand' },
          { position: 1, text: 'Return an editable file' },
        ],
      },
      tag: { id: tagId, name: `v2 Design ${tagId}` },
      mode: 'FIRST_COME_FIRST_SERVED',
      participation: 'SINGLE',
      state: 'QUEST_DRAFT',
      questFundingTotal: 1.03,
      headcount: 1,
      dueAt: '2030-08-26T05:00:00.000Z',
      proofRequired: false,
      locations: [{ label: 'Online' }],
    });
    expect(first.quest).not.toHaveProperty('reward');
    expect(first.quest).not.toHaveProperty('questStatus');

    const replay = await createQuestV2(hirerId, baseInput, 'v2-create-1');
    expect(replay).toEqual(first);

    const changed = await createQuestV2(
      hirerId,
      { ...baseInput, title: 'Changed title' },
      'v2-create-1',
    );
    expect(changed).toEqual({ outcome: 'idempotency-key-reused' });

    const detail = await getQuestV2Detail(hirerId, first.quest.id);
    expect(detail).toEqual(first.quest);
    expect(await getQuestV2Detail(otherMemberId, first.quest.id)).toBeUndefined();

    const own = await listOwnQuestV2(hirerId, { limit: 20 });
    expect(own.items).toEqual([first.quest]);
    expect(await listOwnQuestV2(otherMemberId, { limit: 20 })).toEqual({
      items: [],
      nextCursor: null,
    });

    const legacyView = await listOwnQuests(hirerId, { limit: 20 });
    expect(legacyView.items.map((item) => item.id)).not.toContain(first.quest.id);

    const [storedQuest] = await db
      .select({
        apiVersion: quest.apiVersion,
        v2Mode: quest.v2Mode,
        v2Participation: quest.v2Participation,
        rewardSatang: quest.rewardSatang,
        questFundingTotalSatang: quest.questFundingTotalSatang,
      })
      .from(quest)
      .where(and(eq(quest.id, first.quest.id), eq(quest.hirerId, hirerId)));
    expect(storedQuest).toEqual({
      apiVersion: 'v2',
      v2Mode: 'FIRST_COME_FIRST_SERVED',
      v2Participation: 'SINGLE',
      rewardSatang: null,
      questFundingTotalSatang: 103,
    });

    const conditionRows = await db
      .select({ position: questConditionItem.position, text: questConditionItem.text })
      .from(questConditionItem)
      .where(eq(questConditionItem.questId, first.quest.id));
    expect(conditionRows).toEqual([
      { position: 0, text: 'Use the KUQuest brand' },
      { position: 1, text: 'Return an editable file' },
    ]);
  });

  it.each([
    ['one satang precision', 1.01, 101],
    ['maximum funding total', 700000, 70000000],
  ])('stores %s as integer Satang without setting Quest Reward', async (_, funding, expected) => {
    const result = await createQuestV2(
      hirerId,
      { ...baseInput, questFundingTotal: funding },
      `v2-funding-${randomUUID()}`,
    );
    if (!('quest' in result)) throw new Error(`Create failed: ${result.outcome}`);
    questIds.push(result.quest.id);

    const [storedQuest] = await db
      .select({
        rewardSatang: quest.rewardSatang,
        questFundingTotalSatang: quest.questFundingTotalSatang,
      })
      .from(quest)
      .where(eq(quest.id, result.quest.id));

    expect(storedQuest).toEqual({
      rewardSatang: null,
      questFundingTotalSatang: expected,
    });
  });

  it('rejects funding totals with more than two decimal places', async () => {
    const result = await createQuestV2(
      hirerId,
      { ...baseInput, questFundingTotal: 1.001 },
      `v2-funding-precision-${randomUUID()}`,
    );

    expect(result).toEqual({ outcome: 'invalid-funding' });
  });

  it.each([
    ['missing label', {}],
    ['null label', { label: null }],
    ['blank label', { label: '   ' }],
  ])('rejects a location with %s', async (_, location) => {
    const result = await createQuestV2(
      hirerId,
      { ...baseInput, locations: [location] } as unknown as QuestV2CreateInput,
      `v2-location-${randomUUID()}`,
    );

    expect(result).toEqual({ outcome: 'invalid-location' });
  });

  it('exposes the same canonical resource through the HTTP boundary', async () => {
    const request = new Request('http://localhost/api/v2/quests', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'v2-http-create-1',
        cookie: sessionCookie,
      },
      body: JSON.stringify({
        ...baseInput,
        title: 'HTTP Quest',
        tagId: null,
        locations: [],
      }),
    });
    const response = await app.handle(request);
    expect(response.status).toBe(200);
    const created = (await response.json()) as {
      success: true;
      data: { id: string; state: string; questFundingTotal: number };
    };
    questIds.push(created.data.id);
    expect(created.data).toMatchObject({
      state: 'QUEST_DRAFT',
      questFundingTotal: 1.03,
    });

    const replay = await app.handle(
      new Request('http://localhost/api/v2/quests', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'v2-http-create-1',
          cookie: sessionCookie,
        },
        body: JSON.stringify({
          ...baseInput,
          title: 'HTTP Quest',
          tagId: null,
          locations: [],
        }),
      }),
    );
    expect(replay.status).toBe(200);
    expect((await replay.json()).data).toEqual(created.data);

    const list = await app.handle(
      new Request('http://localhost/api/v2/quests/mine', {
        headers: { cookie: sessionCookie },
      }),
    );
    expect(list.status).toBe(200);
    expect((await list.json()).data.items).toEqual([created.data]);

    const detail = await app.handle(
      new Request(`http://localhost/api/v2/quests/${created.data.id}`, {
        headers: { cookie: sessionCookie },
      }),
    );
    expect(detail.status).toBe(200);
    expect((await detail.json()).data).toEqual(created.data);
  });
});

const invalidHttpInputs: Array<[string, Record<string, unknown>, string]> = [
  ['empty Condition Items', { condition: { items: [] } }, 'VALIDATION'],
  ['blank Condition Item', { condition: { items: ['   '] } }, 'VALIDATION'],
  ['title over the text limit', { title: 'x'.repeat(121) }, 'VALIDATION'],
  ['description over the text limit', { description: 'x'.repeat(1001) }, 'VALIDATION'],
  [
    'dueAt before startTime',
    { dueAt: '2030-08-26T09:00:00.000+07:00' },
    'INVALID_QUEST_DATES',
  ],
  ['funding with more than two decimals', { questFundingTotal: 1.001 }, 'VALIDATION'],
  ['headcount over maximum', { headcount: 21 }, 'VALIDATION'],
  ['SINGLE participation with multiple Workers', { headcount: 2 }, 'INVALID_HEADCOUNT'],
  ['location without label', { locations: [{}] }, 'VALIDATION'],
  ['location with null label', { locations: [{ label: null }] }, 'VALIDATION'],
  ['location with blank label', { locations: [{ label: '   ' }] }, 'VALIDATION'],
];

describe('Quest API v2 HTTP validation and ownership', () => {
  it.each(invalidHttpInputs)('rejects %s with the shared error envelope', async (_, changes, code) => {
    const response = await postQuest({ ...baseInput, ...changes });
    expect(response.status).toBe(400);

    const body = (await response.json()) as {
      success: boolean;
      error: { code: string; message: string };
    };
    expect(body).toEqual({
      success: false,
      error: { code, message: expect.any(String) },
    });
  });

  it('accepts exact two-decimal funding at the HTTP boundary', async () => {
    const response = await postQuest({
      ...baseInput,
      questFundingTotal: 1.01,
      locations: [],
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      success: true;
      data: { id: string; questFundingTotal: number };
    };
    questIds.push(body.data.id);
    expect(body.data.questFundingTotal).toBe(1.01);
  });

  it('returns 404 QUEST_NOT_FOUND with the complete envelope for missing and non-owned Quests', async () => {
    const expected = {
      success: false,
      error: { code: 'QUEST_NOT_FOUND', message: 'Quest not found' },
    };

    const missing = await getQuest(randomUUID());
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual(expected);

    const created = await createQuestV2(
      otherMemberId,
      { ...baseInput, title: 'Other Hirer Quest' },
      `v2-other-owned-${randomUUID()}`,
    );
    if (!('quest' in created)) throw new Error(`Create failed: ${created.outcome}`);
    questIds.push(created.quest.id);

    const nonOwned = await getQuest(created.quest.id);
    expect(nonOwned.status).toBe(404);
    expect(await nonOwned.json()).toEqual(expected);
  });
});
