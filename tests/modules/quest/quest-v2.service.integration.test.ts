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
  questV2CreateOperationScope,
  questV2EditOperationScope,
  type QuestV2CreateInput,
} from '@/modules/quest';
import { questStatus } from '@/modules/quest/quest.contract';

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
const retryTagId = randomUUID();
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

const patchQuest = (
  questId: string,
  body: unknown,
  version: number | string | undefined,
  key = `quest-v2-edit-${randomUUID()}`,
) => {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'idempotency-key': key,
    cookie: sessionCookie,
  };
  if (version !== undefined) headers['if-match'] = String(version);

  return app.handle(
    new Request(`http://localhost/api/v2/quests/${questId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    }),
  );
};

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
  await db.delete(tag).where(eq(tag.id, retryTagId));
  await db.delete(authUser).where(eq(authUser.id, otherMemberId));
});

describe('Quest API v2 persistence', () => {
  it('creates, replays, and reads a canonical Quest Draft', async () => {
    const first = await createQuestV2(hirerId, baseInput, 'v2-create-1');
    if (!('quest' in first)) throw new Error(`Create failed: ${first.outcome}`);
    questIds.push(first.quest.id);

    expect(first.quest).toMatchObject({
      version: 1,
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

    const [storedIdempotency] = await db
      .select({ resultData: walletIdempotencyKey.resultData })
      .from(walletIdempotencyKey)
      .where(
        and(
          eq(walletIdempotencyKey.principalUserId, hirerId),
          eq(walletIdempotencyKey.operationScope, questV2CreateOperationScope),
          eq(walletIdempotencyKey.key, 'v2-create-1'),
        ),
      );
    expect(storedIdempotency?.resultData).toMatchObject({ questFundingTotalSatang: 103 });
    expect(storedIdempotency?.resultData).not.toHaveProperty('questFundingTotal');

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

describe('Quest API v2 Draft editing', () => {
  it('edits an owned Draft and replaces its collections atomically', async () => {
    const created = await createQuestV2(
      hirerId,
      baseInput,
      `v2-edit-create-${randomUUID()}`,
    );
    if (!('quest' in created)) throw new Error(`Create failed: ${created.outcome}`);
    questIds.push(created.quest.id);

    const response = await patchQuest(
      created.quest.id,
      {
        title: 'Updated poster',
        description: null,
        condition: { items: ['Only the final PDF', 'Include the source file'] },
        locations: [],
      },
      1,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: true;
      data: {
        version: number;
        title: string;
        description: string | null;
        condition: { items: unknown[] };
        locations: unknown[];
      };
    };
    expect(body.data).toMatchObject({
      version: 2,
      title: 'Updated poster',
      description: null,
      condition: {
        items: [
          { position: 0, text: 'Only the final PDF' },
          { position: 1, text: 'Include the source file' },
        ],
      },
      locations: [],
    });

    const detail = await getQuest(created.quest.id);
    expect((await detail.json()).data).toEqual(body.data);
  });

  it('rejects a stale version without changing the Draft', async () => {
    const created = await createQuestV2(
      hirerId,
      baseInput,
      `v2-edit-conflict-create-${randomUUID()}`,
    );
    if (!('quest' in created)) throw new Error(`Create failed: ${created.outcome}`);
    questIds.push(created.quest.id);

    const current = await patchQuest(
      created.quest.id,
      { title: 'Current title' },
      1,
      `v2-edit-current-${randomUUID()}`,
    );
    expect(current.status).toBe(200);
    const currentBody = await current.json();

    const stale = await patchQuest(
      created.quest.id,
      {
        title: 'Stale title',
        condition: { items: ['This must not be stored'] },
        locations: [],
      },
      1,
      `v2-edit-stale-${randomUUID()}`,
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      success: false,
      error: {
        code: 'QUEST_EDIT_CONFLICT',
        message: 'The Draft was changed by another request',
      },
    });

    const detail = await getQuest(created.quest.id);
    expect((await detail.json()).data).toEqual(currentBody.data);
  });

  it('lets only the first concurrent edit commit for one Draft version', async () => {
    const created = await createQuestV2(
      hirerId,
      baseInput,
      `v2-edit-concurrent-create-${randomUUID()}`,
    );
    if (!('quest' in created)) throw new Error(`Create failed: ${created.outcome}`);
    questIds.push(created.quest.id);

    const responses = await Promise.all([
      patchQuest(
        created.quest.id,
        { title: 'First concurrent title' },
        1,
        `v2-edit-concurrent-a-${randomUUID()}`,
      ),
      patchQuest(
        created.quest.id,
        { title: 'Second concurrent title' },
        1,
        `v2-edit-concurrent-b-${randomUUID()}`,
      ),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);

    const bodies = await Promise.all(responses.map((response) => response.json()));
    const conflict = bodies.find((body) => body.success === false) as
      | { success: false; error: { code: string } }
      | undefined;
    expect(conflict?.error.code).toBe('QUEST_EDIT_CONFLICT');

    const detail = await getQuestV2Detail(hirerId, created.quest.id);
    if (!detail) throw new Error('Concurrent edit removed the Quest');
    expect(detail.version).toBe(2);
    expect(['First concurrent title', 'Second concurrent title']).toContain(detail.title);
  });

  it('rolls back scalar and collection changes when the transaction fails', async () => {
    const created = await createQuestV2(
      hirerId,
      baseInput,
      `v2-edit-rollback-create-${randomUUID()}`,
    );
    if (!('quest' in created)) throw new Error(`Create failed: ${created.outcome}`);
    questIds.push(created.quest.id);

    const maximumIntegerVersion = 2_147_483_647;
    await db
      .update(quest)
      .set({ version: maximumIntegerVersion })
      .where(eq(quest.id, created.quest.id));
    const before = await getQuestV2Detail(hirerId, created.quest.id);

    const response = await patchQuest(
      created.quest.id,
      {
        title: 'This must roll back',
        condition: { items: ['This must roll back too'] },
        locations: [],
      },
      maximumIntegerVersion,
      `v2-edit-rollback-${randomUUID()}`,
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });

    expect(await getQuestV2Detail(hirerId, created.quest.id)).toEqual(before);
  });

  it('allows the same idempotency key to retry after a transaction rollback', async () => {
    const created = await createQuestV2(
      hirerId,
      baseInput,
      `v2-edit-retry-create-${randomUUID()}`,
    );
    if (!('quest' in created)) throw new Error(`Create failed: ${created.outcome}`);
    questIds.push(created.quest.id);

    const key = `v2-edit-retry-${randomUUID()}`;
    const edit = { tagId: retryTagId };
    const failed = await patchQuest(created.quest.id, edit, 1, key);
    expect(failed.status).toBe(400);
    expect(await failed.json()).toEqual({
      success: false,
      error: { code: 'TAG_NOT_FOUND', message: 'Tag not found' },
    });

    const [rolledBackIdempotency] = await db
      .select({ id: walletIdempotencyKey.id })
      .from(walletIdempotencyKey)
      .where(
        and(
          eq(walletIdempotencyKey.principalUserId, hirerId),
          eq(walletIdempotencyKey.operationScope, questV2EditOperationScope),
          eq(walletIdempotencyKey.key, key),
        ),
      );
    expect(rolledBackIdempotency).toBeUndefined();

    await db.insert(tag).values({ id: retryTagId, name: `Retry Tag ${retryTagId}` });
    const retried = await patchQuest(created.quest.id, edit, 1, key);
    expect(retried.status).toBe(200);
    expect((await retried.json()).data).toMatchObject({
      version: 2,
      tag: { id: retryTagId, name: `Retry Tag ${retryTagId}` },
    });
  });

  it('replays the same edit and rejects reuse with a different request', async () => {
    const created = await createQuestV2(
      hirerId,
      baseInput,
      `v2-edit-idempotency-create-${randomUUID()}`,
    );
    if (!('quest' in created)) throw new Error(`Create failed: ${created.outcome}`);
    questIds.push(created.quest.id);

    const key = `v2-edit-idempotency-${randomUUID()}`;
    const edit = { title: 'Idempotent title' };
    const first = await patchQuest(created.quest.id, edit, 1, key);
    expect(first.status).toBe(200);
    const firstBody = await first.json();

    const later = await patchQuest(
      created.quest.id,
      { title: 'Later title' },
      2,
      `v2-edit-later-${randomUUID()}`,
    );
    expect(later.status).toBe(200);

    const replay = await patchQuest(created.quest.id, edit, 1, key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);

    const changed = await patchQuest(created.quest.id, { title: 'Different title' }, 1, key);
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({
      success: false,
      error: {
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'Idempotency key was used with a different request',
      },
    });
  });

  it('requires a positive If-Match version and a non-empty edit', async () => {
    const created = await createQuestV2(
      hirerId,
      baseInput,
      `v2-edit-version-create-${randomUUID()}`,
    );
    if (!('quest' in created)) throw new Error(`Create failed: ${created.outcome}`);
    questIds.push(created.quest.id);

    const missing = await patchQuest(
      created.quest.id,
      { title: 'Missing version' },
      undefined,
      `v2-edit-missing-version-${randomUUID()}`,
    );
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.code).toBe('VALIDATION');

    const malformed = await patchQuest(
      created.quest.id,
      { title: 'Malformed version' },
      'not-a-version',
      `v2-edit-malformed-version-${randomUUID()}`,
    );
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error).toEqual({
      code: 'INVALID_VERSION',
      message: 'If-Match must be a positive integer',
    });

    const empty = await patchQuest(
      created.quest.id,
      {},
      1,
      `v2-edit-empty-${randomUUID()}`,
    );
    expect(empty.status).toBe(400);
    expect((await empty.json()).error.code).toBe('VALIDATION');
  });

  it('allows only the owning Hirer to edit a Draft and rejects non-Draft State', async () => {
    const created = await createQuestV2(
      hirerId,
      baseInput,
      `v2-edit-owner-create-${randomUUID()}`,
    );
    if (!('quest' in created)) throw new Error(`Create failed: ${created.outcome}`);
    questIds.push(created.quest.id);

    const otherOwner = await createQuestV2(
      otherMemberId,
      { ...baseInput, title: 'Other Hirer Draft' },
      `v2-edit-other-owner-${randomUUID()}`,
    );
    if (!('quest' in otherOwner)) throw new Error(`Create failed: ${otherOwner.outcome}`);
    questIds.push(otherOwner.quest.id);

    const notOwned = await patchQuest(
      otherOwner.quest.id,
      { title: 'Not allowed' },
      1,
      `v2-edit-not-owned-${randomUUID()}`,
    );
    expect(notOwned.status).toBe(404);
    expect(await notOwned.json()).toEqual({
      success: false,
      error: { code: 'QUEST_NOT_FOUND', message: 'Quest not found' },
    });

    await db
      .update(quest)
      .set({ questStatus: questStatus.open, rewardSatang: 100 })
      .where(eq(quest.id, created.quest.id));

    const notDraft = await patchQuest(
      created.quest.id,
      { title: 'Closed for editing' },
      1,
      `v2-edit-not-draft-${randomUUID()}`,
    );
    expect(notDraft.status).toBe(409);
    expect(await notDraft.json()).toEqual({
      success: false,
      error: { code: 'QUEST_NOT_DRAFT', message: 'Only Draft Quests can be edited' },
    });
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
