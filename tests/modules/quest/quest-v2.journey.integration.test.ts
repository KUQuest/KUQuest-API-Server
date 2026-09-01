import { app } from '@/app';
import { db, sql } from '@/database/client';
import { file } from '@/database/schema/file.schema';
import { quest } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import {
  walletFundingReservation,
  walletLedgerAccount,
} from '@/database/schema/wallet.schema';
import { createStagingTestAuthRoute } from '@/modules/auth';
import type { QuestV2CreateInput } from '@/modules/quest';
import { questV2Storage } from '@/modules/quest/quest.storage';
import {
  createSealedLedgerTransaction,
  ensureInitialMoneyPolicy,
  ensureWallet,
  releaseFundingReservation,
  signedSatang,
} from '@/modules/wallet';

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
  }),
);

const getCookieHeader = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');

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

const fundHirer = async (amountSatang: number) => {
  const wallet = await ensureWallet(hirerId);
  const [spendingAccount] = await db
    .select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(and(
      eq(walletLedgerAccount.walletId, wallet.id),
      eq(walletLedgerAccount.type, 'SPENDING'),
    ));
  const [suspenseAccount] = await db
    .select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(eq(walletLedgerAccount.code, 'platform:PLATFORM_SUSPENSE'));
  if (!spendingAccount || !suspenseAccount) throw new Error('Missing funding accounts');

  await createSealedLedgerTransaction({
    businessReference: `quest-v2-journey-funding-${randomUUID()}`,
    eventType: 'TOP_UP',
    postings: [
      { accountId: spendingAccount.id, amountSatang: signedSatang(amountSatang) },
      { accountId: suspenseAccount.id, amountSatang: signedSatang(-amountSatang) },
    ],
  });
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
    }),
  );

const patchQuest = (
  questId: string,
  body: unknown,
  version: number,
  key: string,
) =>
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
    }),
  );

const postImages = (questId: string, files: File[], key: string) => {
  const form = new FormData();
  for (const image of files) form.append('images', image);

  return app.handle(
    new Request(`http://localhost/api/v2/quests/${questId}/images`, {
      method: 'POST',
      headers: { 'idempotency-key': key, cookie: sessionCookie },
      body: form,
    }),
  );
};

const getQuest = (questId: string) =>
  app.handle(
    new Request(`http://localhost/api/v2/quests/${questId}`, {
      headers: { cookie: sessionCookie },
    }),
  );

const getPublishCheck = (questId: string) =>
  app.handle(
    new Request(`http://localhost/api/v2/quests/${questId}/publish-check`, {
      headers: { cookie: sessionCookie },
    }),
  );

const postPublish = (questId: string, key: string) =>
  app.handle(
    new Request(`http://localhost/api/v2/quests/${questId}/publish`, {
      method: 'POST',
      headers: { 'idempotency-key': key, cookie: sessionCookie },
    }),
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
    }),
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

  const reservations = await db
    .select({ id: walletFundingReservation.id })
    .from(walletFundingReservation)
    .where(and(
      eq(walletFundingReservation.ownerUserId, hirerId),
      eq(walletFundingReservation.status, 'ACTIVE'),
    ));
  await Promise.all(reservations.map((reservation) =>
    db.transaction((transaction) => releaseFundingReservation(transaction, {
      ownerUserId: hirerId,
      reservationId: reservation.id,
      operationReference: `quest-v2-journey-cleanup-${randomUUID()}`,
    })),
  ));

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
      await fundHirer(100_000);
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
        editKey,
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
        }),
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
        imageKey,
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
        version: 2,
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
        }),
      );
      expect(mineResponse.status).toBe(200);
      const mineItems = (await mineResponse.json()).data.items as Array<Record<string, unknown>>;
      const { images: _images, ...canonicalQuest } = detail.data;
      expect(mineItems).toContainEqual(canonicalQuest);
    },
  );

  it('publishes an online Quest with zero locations and zero Quest Images', async () => {
    await fundHirer(5_000);
    const createResponse = await postQuest(
      { ...baseInput, locations: [] },
      `journey-online-create-${randomUUID()}`,
    );
    expect(createResponse.status).toBe(200);
    const created = (await createResponse.json()) as { success: true; data: { id: string } };
    questIds.push(created.data.id);

    const publishResponse = await postPublish(
      created.data.id,
      `journey-online-publish-${randomUUID()}`,
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
    await fundHirer(5_000);
    const createResponse = await postQuest(
      { ...baseInput, title: 'Race source Quest', locations: [] },
      `journey-race-create-${randomUUID()}`,
    );
    expect(createResponse.status).toBe(200);
    const created = (await createResponse.json()) as { success: true; data: { id: string } };
    questIds.push(created.data.id);

    const [editResponse, publishResponse] = await Promise.all([
      patchQuest(
        created.data.id,
        { title: 'Race edited Quest' },
        1,
        `journey-race-edit-${randomUUID()}`,
      ),
      postPublish(created.data.id, `journey-race-publish-${randomUUID()}`),
    ]);

    expect(publishResponse.status).toBe(200);
    expect([200, 409]).toContain(editResponse.status);
    if (editResponse.status === 409) {
      expect((await editResponse.json()).error.code).toBe('QUEST_NOT_DRAFT');
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
      editResponse.status === 200 ? 'Race edited Quest' : 'Race source Quest',
    );
    expect(detail.version).toBe(editResponse.status === 200 ? 2 : 1);

    const reservations = await db
      .select({ id: walletFundingReservation.id })
      .from(walletFundingReservation)
      .where(and(
        eq(walletFundingReservation.ownerUserId, hirerId),
        eq(walletFundingReservation.callerScope, 'quest'),
        eq(walletFundingReservation.callerReference, created.data.id),
      ));
    expect(reservations).toHaveLength(1);
  });

  it('keeps a published v2 Quest out of v1 reads', async () => {
    await fundHirer(5_000);
    const createResponse = await postQuest(
      { ...baseInput, title: 'Version boundary Quest', locations: [] },
      `journey-v1-boundary-create-${randomUUID()}`,
    );
    expect(createResponse.status).toBe(200);
    const created = (await createResponse.json()) as { success: true; data: { id: string } };
    questIds.push(created.data.id);

    const publishResponse = await postPublish(
      created.data.id,
      `journey-v1-boundary-publish-${randomUUID()}`,
    );
    expect(publishResponse.status).toBe(200);

    const v1MineResponse = await app.handle(
      new Request('http://localhost/api/v1/quests/mine', {
        headers: { cookie: sessionCookie },
      }),
    );
    expect(v1MineResponse.status).toBe(200);
    expect(
      (await v1MineResponse.json()).data.items.map((item: { id: string }) => item.id),
    ).not.toContain(created.data.id);

    const v1DetailResponse = await app.handle(
      new Request(`http://localhost/api/v1/quests/${created.data.id}`, {
        headers: { cookie: sessionCookie },
      }),
    );
    expect(v1DetailResponse.status).toBe(404);
    expect((await v1DetailResponse.json()).error.code).toBe('QUEST_NOT_FOUND');
  });
});
