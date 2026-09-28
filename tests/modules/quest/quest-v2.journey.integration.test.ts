import { app } from '@/app';
import { db, sql } from '@/database/client';
import { file } from '@/database/schema/file.schema';
import { quest, questApiVersion } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { createStagingTestAuthRoute } from '@/modules/auth';
import type { QuestV2CreateInput } from '@/modules/quest';
import { questV2Storage } from '@/modules/quest/v2';
import { ensureInitialMoneyPolicy } from '@/modules/wallet';
import {
  fundTestWallet,
  listTestQuestEscrows,
  releaseTestQuestEscrows,
} from '../wallet/wallet-test-fixtures';

import { randomUUID } from 'node:crypto';

import { Elysia } from 'elysia';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test';

const testEmail = `quest-v2-journey-${randomUUID()}@ku.th`;
const testPassword = 'TestStudent1!';
const authTestApp = new Elysia({ name: 'quest-v2-journey-test-auth' }).use(
  createStagingTestAuthRoute({
    enabled: true,
    deploymentEnv: 'staging',
    email: testEmail,
    password: testPassword,
    firstName: 'Journey',
    lastName: 'Hirer',
  })
);

const getCookieHeader = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? []).map((cookie) => cookie.split(';', 1)[0]).join('; ');

let hirerId = '';
let sessionCookie = '';
const tagId = randomUUID();
const questIds: string[] = [];

const baseInput: QuestV2CreateInput = {
  title: 'Create a journey Quest',
  description: 'Verify the complete Hirer flow',
  condition: { items: ['Return the finished work'] },
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

const postQuest = (body: QuestV2CreateInput, key: string) =>
  app.handle(
    new Request('http://localhost/api/v2/quests', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': key,
        cookie: sessionCookie,
      },
      body: JSON.stringify(body),
    })
  );

const patchQuest = (questId: string, body: unknown, version: number, key: string) =>
  app.handle(
    new Request(`http://localhost/api/v2/quests/${questId}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': key,
        'if-match': String(version),
        cookie: sessionCookie,
      },
      body: JSON.stringify(body),
    })
  );

const postImages = (questId: string, files: File[], key: string) => {
  const form = new FormData();
  for (const image of files) form.append('images', image);

  return app.handle(
    new Request(`http://localhost/api/v2/quests/${questId}/images`, {
      method: 'POST',
      headers: { 'idempotency-key': key, cookie: sessionCookie },
      body: form,
    })
  );
};

const getQuest = (questId: string) =>
  app.handle(
    new Request(`http://localhost/api/v2/quests/${questId}`, {
      headers: { cookie: sessionCookie },
    })
  );

const getPublishCheck = (questId: string) =>
  app.handle(
    new Request(`http://localhost/api/v2/quests/${questId}/publish-check`, {
      headers: { cookie: sessionCookie },
    })
  );

const postPublish = (questId: string, key: string) =>
  app.handle(
    new Request(`http://localhost/api/v2/quests/${questId}/publish`, {
      method: 'POST',
      headers: { 'idempotency-key': key, cookie: sessionCookie },
    })
  );

const postCancel = (questId: string, key: string) =>
  app.handle(
    new Request(`http://localhost/api/v2/quests/${questId}/cancel`, {
      method: 'POST',
      headers: { 'idempotency-key': key, cookie: sessionCookie },
    })
  );

const makeImageFile = () =>
  new File([new Uint8Array([1, 2, 3])], 'journey.png', { type: 'image/png' });

beforeAll(async () => {
  await sql`select 1`;
  await ensureInitialMoneyPolicy();

  const loginResponse = await authTestApp.handle(
    new Request('http://localhost/api/staging/test-auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: testEmail, password: testPassword }),
    })
  );
  if (loginResponse.status !== 200) {
    throw new Error(`Quest v2 journey authentication failed: ${loginResponse.status}`);
  }

  hirerId = ((await loginResponse.json()) as { user: { id: string } }).user.id;
  sessionCookie = getCookieHeader(loginResponse);
  await db.insert(tag).values({ id: tagId, name: `Journey ${tagId}` });
});

afterEach(() => mock.restore());

afterAll(async () => {
  await db.delete(quest).where(inArray(quest.id, questIds));
  await db.delete(file).where(eq(file.uploadedByUserId, hirerId));

  await releaseTestQuestEscrows([hirerId]);

  await db.delete(tag).where(eq(tag.id, tagId));
});

describe('Quest API v2 Hirer journey', () => {
  it.each([
    ['FIRST_COME_FIRST_SERVED', 'SINGLE', 1],
    ['FIRST_COME_FIRST_SERVED', 'GROUP', 3],
    ['CANDIDATE', 'SINGLE', 1],
    ['CANDIDATE', 'GROUP', 3],
  ] as const)(
    'completes create, edit, image upload, publish-check, and publish for %s %s',
    async (mode, participation, headcount) => {
      await fundTestWallet(hirerId, 100_000);
      const input = { ...baseInput, mode, participation, headcount };
      const createKey = `journey-create-${randomUUID()}`;

      const createResponse = await postQuest(input, createKey);
      expect(createResponse.status).toBe(200);
      const created = (await createResponse.json()) as {
        success: true;
        data: Record<string, unknown> & { id: string };
      };
      questIds.push(created.data.id);
      expect(created.data).toMatchObject({
        state: 'QUEST_DRAFT',
        version: 1,
        mode,
        participation,
        headcount,
        locations: [],
      });
      expect(created.data).not.toHaveProperty('platformFee');
      expect(created.data).not.toHaveProperty('questEscrow');

      const createReplay = await postQuest(input, createKey);
      expect(createReplay.status).toBe(200);
      expect((await createReplay.json()).data).toEqual(created.data);

      const createConflict = await postQuest({ ...input, title: 'Changed request' }, createKey);
      expect(createConflict.status).toBe(409);
      expect((await createConflict.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED');

      const editBody = {
        title: 'Edited journey Quest',
        description: 'The edited Quest contract',
        condition: { items: ['Return the edited work'] },
        locations: [],
      };
      const editKey = `journey-edit-${randomUUID()}`;
      const editResponse = await patchQuest(created.data.id, editBody, 1, editKey);
      expect(editResponse.status).toBe(200);
      const edited = (await editResponse.json()) as {
        success: true;
        data: Record<string, unknown>;
      };
      expect(edited.data).toMatchObject({
        state: 'QUEST_DRAFT',
        version: 2,
        title: 'Edited journey Quest',
        locations: [],
      });

      const editReplay = await patchQuest(created.data.id, editBody, 1, editKey);
      expect(editReplay.status).toBe(200);
      expect((await editReplay.json()).data).toEqual(edited.data);

      const editConflict = await patchQuest(
        created.data.id,
        { title: 'Changed edit request' },
        2,
        editKey
      );
      expect(editConflict.status).toBe(409);
      expect((await editConflict.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED');

      spyOn(questV2Storage, 'prepareUpload').mockImplementation((userId) => ({
        bucket: 'test-bucket',
        objectKey: `quests/v2/${userId}/${randomUUID()}`,
      }));
      const upload = spyOn(questV2Storage, 'upload').mockImplementation(
        async (_userId, image, plan) => ({
          bucket: plan?.bucket ?? 'test-bucket',
          objectKey: plan?.objectKey ?? `quests/v2/${hirerId}/${image.name}`,
          contentType: 'image/png',
          sizeBytes: image.size,
          fileName: image.name,
        })
      );
      spyOn(questV2Storage, 'linkForWithExpiry').mockImplementation((image) => ({
        url: `https://storage.test/${image.objectKey}`,
        expiresAt: new Date('2030-08-26T10:15:00.000Z'),
      }));

      const image = makeImageFile();
      const imageKey = `journey-image-${randomUUID()}`;
      const imageResponse = await postImages(created.data.id, [image], imageKey);
      expect(imageResponse.status).toBe(200);
      const uploaded = (await imageResponse.json()) as {
        success: true;
        data: { images: Array<Record<string, unknown>> };
      };
      expect(uploaded.data.images).toHaveLength(1);
      expect(uploaded.data.images[0]).toMatchObject({ position: 0 });

      const imageReplay = await postImages(created.data.id, [image], imageKey);
      expect(imageReplay.status).toBe(200);
      expect((await imageReplay.json()).data).toEqual(uploaded.data);
      expect(upload).toHaveBeenCalledTimes(1);

      const imageConflict = await postImages(
        created.data.id,
        [new File([new Uint8Array([4, 5, 6])], 'changed.png', { type: 'image/png' })],
        imageKey
      );
      expect(imageConflict.status).toBe(409);
      expect((await imageConflict.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED');

      const checkResponse = await getPublishCheck(created.data.id);
      expect(checkResponse.status).toBe(200);
      const check = (await checkResponse.json()) as {
        success: true;
        data: {
          canPublish: boolean;
          blockingReasons: unknown[];
          questFundingTotal: number;
          questReward: number;
          platformFee: number;
          escrowRequirement: number;
          headcount: number;
        };
      };
      expect(check.data).toMatchObject({
        canPublish: true,
        blockingReasons: [],
        questFundingTotal: 20,
        questReward: 19.6,
        platformFee: 0.4,
        escrowRequirement: 20 * headcount,
        headcount,
      });

      const publishKey = `journey-publish-${randomUUID()}`;
      const publishResponse = await postPublish(created.data.id, publishKey);
      expect(publishResponse.status).toBe(200);
      const published = (await publishResponse.json()) as {
        success: true;
        data: {
          quest: Record<string, unknown>;
          questEscrow: Record<string, unknown>;
        };
      };
      expect(published.data.quest).toMatchObject({
        id: created.data.id,
        state: 'QUEST_OPEN',
        version: 3,
        title: 'Edited journey Quest',
        mode,
        participation,
        headcount,
        locations: [],
      });
      expect(published.data.quest).not.toHaveProperty('platformFee');
      expect(published.data.questEscrow).toMatchObject({
        questFundingTotal: 20,
        questReward: 19.6,
        platformFee: 0.4,
        escrowRequirement: 20 * headcount,
        headcount,
      });

      const publishReplay = await postPublish(created.data.id, publishKey);
      expect(publishReplay.status).toBe(200);
      expect(await publishReplay.json()).toEqual(published);

      const detailResponse = await getQuest(created.data.id);
      expect(detailResponse.status).toBe(200);
      const detail = (await detailResponse.json()) as {
        success: true;
        data: Record<string, unknown> & { images: unknown[] };
      };
      expect(detail.data).toMatchObject({
        state: 'QUEST_OPEN',
        title: 'Edited journey Quest',
        locations: [],
      });
      expect(detail.data.images).toHaveLength(1);
      expect(detail.data).not.toHaveProperty('platformFee');
      expect(detail.data).not.toHaveProperty('questEscrow');

      const mineResponse = await app.handle(
        new Request('http://localhost/api/v2/quests/mine', {
          headers: { cookie: sessionCookie },
        })
      );
      expect(mineResponse.status).toBe(200);
      const mineItems = (await mineResponse.json()).data.items as Array<Record<string, unknown>>;
      const { images: _images, ...canonicalQuest } = detail.data;
      expect(mineItems).toContainEqual(canonicalQuest);
    }
  );

  it('publishes an online Quest with zero locations and zero Quest Images', async () => {
    await fundTestWallet(hirerId, 5_000);
    const createResponse = await postQuest(
      { ...baseInput, locations: [] },
      `journey-online-create-${randomUUID()}`
    );
    expect(createResponse.status).toBe(200);
    const created = (await createResponse.json()) as { success: true; data: { id: string } };
    questIds.push(created.data.id);

    const publishResponse = await postPublish(
      created.data.id,
      `journey-online-publish-${randomUUID()}`
    );
    expect(publishResponse.status).toBe(200);

    const detailResponse = await getQuest(created.data.id);
    expect(detailResponse.status).toBe(200);
    expect((await detailResponse.json()).data).toMatchObject({
      state: 'QUEST_OPEN',
      locations: [],
      images: [],
    });
  });

  it('keeps one committed outcome when Draft edit and publish run concurrently', async () => {
    await fundTestWallet(hirerId, 5_000);
    const createResponse = await postQuest(
      { ...baseInput, title: 'Race source Quest', locations: [] },
      `journey-race-create-${randomUUID()}`
    );
    expect(createResponse.status).toBe(200);
    const created = (await createResponse.json()) as { success: true; data: { id: string } };
    questIds.push(created.data.id);

    const [editResponse, publishResponse] = await Promise.all([
      patchQuest(
        created.data.id,
        { title: 'Race edited Quest' },
        1,
        `journey-race-edit-${randomUUID()}`
      ),
      postPublish(created.data.id, `journey-race-publish-${randomUUID()}`),
    ]);

    expect(publishResponse.status).toBe(200);
    expect([200, 409]).toContain(editResponse.status);
    if (editResponse.status === 409) {
      expect((await editResponse.json()).error.code).toBe('QUEST_EDIT_CONFLICT');
    } else {
      expect((await editResponse.json()).data).toMatchObject({
        version: 2,
        title: 'Race edited Quest',
      });
    }

    const detailResponse = await getQuest(created.data.id);
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()).data as {
      state: string;
      title: string;
      version: number;
    };
    expect(detail).toMatchObject({ state: 'QUEST_OPEN' });
    expect(detail.title).toBe(
      editResponse.status === 200 ? 'Race edited Quest' : 'Race source Quest'
    );
    expect(detail.version).toBe(editResponse.status === 200 ? 3 : 2);

    expect(
      await listTestQuestEscrows({ ownerUserIds: [hirerId], questIds: [created.data.id] })
    ).toHaveLength(1);
  });

  it('keeps a published v2 Quest out of v1 reads', async () => {
    await fundTestWallet(hirerId, 5_000);
    const createResponse = await postQuest(
      { ...baseInput, title: 'Version boundary Quest', locations: [] },
      `journey-v1-boundary-create-${randomUUID()}`
    );
    expect(createResponse.status).toBe(200);
    const created = (await createResponse.json()) as { success: true; data: { id: string } };
    questIds.push(created.data.id);

    const publishResponse = await postPublish(
      created.data.id,
      `journey-v1-boundary-publish-${randomUUID()}`
    );
    expect(publishResponse.status).toBe(200);

    const v1MineResponse = await app.handle(
      new Request('http://localhost/api/v1/quests/mine', {
        headers: { cookie: sessionCookie },
      })
    );
    expect(v1MineResponse.status).toBe(200);
    expect(
      (await v1MineResponse.json()).data.items.map((item: { id: string }) => item.id)
    ).not.toContain(created.data.id);

    const v1DetailResponse = await app.handle(
      new Request(`http://localhost/api/v1/quests/${created.data.id}`, {
        headers: { cookie: sessionCookie },
      })
    );
    expect(v1DetailResponse.status).toBe(404);
    expect((await v1DetailResponse.json()).error.code).toBe('QUEST_NOT_FOUND');
  });

  it('returns 409 QUEST_DRAFT_LIMIT_REACHED when creating more than 10 drafts', async () => {
    const journeyDraftIds: string[] = [];
    try {
      // Fill up to 10 drafts (first clean any current drafts for hirer)
      await db
        .delete(quest)
        .where(and(eq(quest.hirerId, hirerId), eq(quest.questStatus, 'QUEST_DRAFT')));

      for (let i = 0; i < 10; i++) {
        const res = await postQuest(
          { ...baseInput, title: `Draft limit batch ${i + 1}` },
          `journey-draft-limit-${i}-${randomUUID()}`
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { data: { id: string } };
        journeyDraftIds.push(body.data.id);
        questIds.push(body.data.id);
      }

      // 11th creation attempt returns 409
      const overflowRes = await postQuest(
        { ...baseInput, title: 'Draft limit overflow' },
        `journey-draft-limit-11-${randomUUID()}`
      );
      expect(overflowRes.status).toBe(409);
      const errorBody = (await overflowRes.json()) as { error: { code: string; message: string } };
      expect(errorBody.error.code).toBe('QUEST_DRAFT_LIMIT_REACHED');
      expect(errorBody.error.message).toBe('You can have at most 10 active Draft Quests');
    } finally {
      if (journeyDraftIds.length > 0) {
        await db.delete(quest).where(inArray(quest.id, journeyDraftIds));
      }
    }
  });

  it('enforces the 10 active published Quest cap at the concurrent publish boundary', async () => {
    await fundTestWallet(hirerId, 100_000);

    const staleActive = await db
      .select({ id: quest.id })
      .from(quest)
      .where(
        and(
          eq(quest.hirerId, hirerId),
          eq(quest.apiVersion, questApiVersion.v2),
          inArray(quest.questStatus, ['QUEST_OPEN', 'QUEST_ASSIGNED', 'QUEST_IN_PROGRESS'])
        )
      );
    for (const row of staleActive) {
      const cancelResponse = await postCancel(
        row.id,
        `journey-active-limit-precancel-${randomUUID()}`
      );
      expect(cancelResponse.status).toBe(200);
      expect((await cancelResponse.json()).data).toMatchObject({ questStatus: 'QUEST_CANCELLED' });
    }

    for (let i = 0; i < 9; i++) {
      const createResponse = await postQuest(
        { ...baseInput, title: `Active limit Quest ${i + 1}`, locations: [] },
        `journey-active-limit-create-${i}-${randomUUID()}`
      );
      expect(createResponse.status).toBe(200);
      const created = (await createResponse.json()) as { success: true; data: { id: string } };
      questIds.push(created.data.id);

      const publishResponse = await postPublish(
        created.data.id,
        `journey-active-limit-publish-${i}-${randomUUID()}`
      );
      expect(publishResponse.status).toBe(200);
    }

    const contenderIds: string[] = [];
    for (const label of ['A', 'B'] as const) {
      const createResponse = await postQuest(
        { ...baseInput, title: `Active limit contender ${label}`, locations: [] },
        `journey-active-limit-contender-${label}-${randomUUID()}`
      );
      expect(createResponse.status).toBe(200);
      const created = (await createResponse.json()) as { success: true; data: { id: string } };
      questIds.push(created.data.id);
      contenderIds.push(created.data.id);
    }

    const race = await Promise.all(
      contenderIds.map(async (id, index) => {
        const response = await postPublish(
          id,
          `journey-active-limit-race-${index}-${randomUUID()}`
        );
        return {
          id,
          status: response.status,
          body: (await response.json()) as {
            data?: { quest?: Record<string, unknown> };
            error?: { code: string; message: string };
          },
        };
      })
    );
    expect(race.map((entry) => entry.status).sort()).toEqual([200, 409]);

    const [winner, loser] = race[0].status === 200 ? [race[0], race[1]] : [race[1], race[0]];
    expect(winner.body.data).toMatchObject({ quest: { id: winner.id, state: 'QUEST_OPEN' } });
    expect(loser.body.error?.code).toBe('QUEST_ACTIVE_LIMIT_REACHED');
    expect(loser.body.error?.message).toBe('You can have at most 10 active published Quests');

    const checkResponse = await getPublishCheck(loser.id);
    expect(checkResponse.status).toBe(200);
    const check = (await checkResponse.json()) as {
      success: true;
      data: { canPublish: boolean; blockingReasons: Array<{ code: string; message: string }> };
    };
    expect(check.data.canPublish).toBe(false);
    expect(check.data.blockingReasons).toContainEqual({
      code: 'QUEST_ACTIVE_LIMIT_REACHED',
      message: 'You can have at most 10 active published Quests',
    });

    const tenthCancel = await postCancel(winner.id, `journey-active-limit-cancel-${randomUUID()}`);
    expect(tenthCancel.status).toBe(200);
    expect((await tenthCancel.json()).data).toMatchObject({ questStatus: 'QUEST_CANCELLED' });

    const retryResponse = await postPublish(loser.id, `journey-active-limit-retry-${randomUUID()}`);
    expect(retryResponse.status).toBe(200);
    const retried = (await retryResponse.json()) as {
      success: true;
      data: { quest: Record<string, unknown> };
    };
    expect(retried.data.quest).toMatchObject({ id: loser.id, state: 'QUEST_OPEN' });
  });
});
