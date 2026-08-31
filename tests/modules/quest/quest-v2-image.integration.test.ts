import { app } from '@/app';
import { db, sql } from '@/database/client';
import { file } from '@/database/schema/file.schema';
import { quest, questImage } from '@/database/schema/quest.schema';
import { walletIdempotencyKey } from '@/database/schema/wallet.schema';
import { createStagingTestAuthRoute } from '@/modules/auth';
import {
  checkQuestV2ImageUpload,
  cleanupQuestV2ImageObjects,
  createQuestV2,
  getQuestV2Detail,
  questV2ImageUploadOperationScope,
  questV2ImageUploadRequestHash,
  type QuestV2CreateInput,
} from '@/modules/quest';
import { questV2Storage } from '@/modules/quest/quest.storage';
import {
  ImageTooLargeError,
  ImageUploadError,
  UnsupportedImageTypeError,
  createImageStorage,
} from '@/shared/image-storage';

import { Elysia } from 'elysia';
import { eq, inArray } from 'drizzle-orm';
import sharp from 'sharp';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test';

const hirerEmail = `quest-v2-images-${crypto.randomUUID()}@ku.th`;
const password = 'TestStudent1!';
const authTestApp = new Elysia({ name: 'quest-v2-image-test-auth' }).use(
  createStagingTestAuthRoute({
    enabled: true,
    deploymentEnv: 'staging',
    email: hirerEmail,
    password,
    firstName: 'Quest Image',
    lastName: 'Hirer',
  }),
);

const getCookieHeader = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');

let hirerId = '';
let sessionCookie = '';
const questIds: string[] = [];

const baseInput: QuestV2CreateInput = {
  title: 'Quest Image Draft',
  condition: { items: ['Create the gallery'] },
  mode: 'FIRST_COME_FIRST_SERVED',
  participation: 'SINGLE',
  questFundingTotal: 20,
  headcount: 1,
  startTime: '2030-08-26T10:00:00.000Z',
};

const createDraft = async () => {
  const result = await createQuestV2(hirerId, baseInput, `image-create-${crypto.randomUUID()}`);
  if (!('quest' in result)) throw new Error(`Draft creation failed: ${result.outcome}`);
  questIds.push(result.quest.id);
  return result.quest;
};

const postImages = (questId: string, key: string, files: File[]) => {
  const form = new FormData();
  for (const imageFile of files) form.append('images', imageFile);

  return app.handle(
    new Request(`http://localhost/api/v2/quests/${questId}/images`, {
      method: 'POST',
      headers: { cookie: sessionCookie, 'idempotency-key': key },
      body: form,
    }),
  );
};

const makeImageFile = (name: string, bytes: number[] = [1, 2, 3]) =>
  new File([new Uint8Array(bytes)], name, { type: 'image/png' });

const validatingStorage = createImageStorage({
  keyPrefix: 'test-quest-v2-validation',
  bucket: 'test-bucket',
  client: {
    write: async () => 0,
    delete: async () => undefined,
    presign: () => 'https://storage.test/temporary-link',
  },
});

const deleteImage = (questId: string, imageId: string, key: string) =>
  app.handle(
    new Request(`http://localhost/api/v2/quests/${questId}/images/${imageId}`, {
      method: 'DELETE',
      headers: { cookie: sessionCookie, 'idempotency-key': key },
    }),
  );

beforeAll(async () => {
  await sql`select 1`;
  const response = await authTestApp.handle(
    new Request('http://localhost/api/staging/test-auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: hirerEmail, password }),
    }),
  );
  if (response.status !== 200) throw new Error(`Test authentication failed: ${response.status}`);

  hirerId = ((await response.json()) as { user: { id: string } }).user.id;
  sessionCookie = getCookieHeader(response);
});

beforeEach(async () => {
  await db.delete(walletIdempotencyKey).where(
    eq(walletIdempotencyKey.principalUserId, hirerId),
  );
  await db.delete(quest).where(inArray(quest.id, questIds));
  await db.delete(file).where(eq(file.uploadedByUserId, hirerId));
  questIds.splice(0, questIds.length);
});

afterAll(async () => {
  await db.delete(walletIdempotencyKey).where(
    eq(walletIdempotencyKey.principalUserId, hirerId),
  );
  await db.delete(quest).where(inArray(quest.id, questIds));
  await db.delete(file).where(eq(file.uploadedByUserId, hirerId));
});

afterEach(() => mock.restore());

describe('Quest API v2 Quest Image integration', () => {
  it('uploads an ordered gallery, returns expiring links, and safely replays the command', async () => {
    const draft = await createDraft();
    const first = makeImageFile('first.png');
    const second = makeImageFile('second.png', [4, 5, 6]);
    const upload = spyOn(questV2Storage, 'upload').mockImplementation(async (_userId, image) => ({
      bucket: 'test-bucket',
      objectKey: `quests/v2/${hirerId}/${image.name}`,
      contentType: 'image/png',
      sizeBytes: image.size,
    }));
    spyOn(questV2Storage, 'linkForWithExpiry').mockImplementation((image) => ({
      url: `https://storage.test/${image.objectKey}`,
      expiresAt: new Date('2030-08-26T10:15:00.000Z'),
    }));

    const response = await postImages(draft.id, 'image-upload-1', [first, second]);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: true;
      data: {
        images: Array<{
          imageId: string;
          fileId: string;
          position: number;
          url: string;
          urlExpiresAt: string;
        }>;
      };
    };
    expect(body.data.images).toHaveLength(2);
    expect(body.data.images.map((image) => image.position)).toEqual([0, 1]);
    expect(body.data.images[0]).toMatchObject({
      url: 'https://storage.test/quests/v2/' + hirerId + '/first.png',
      urlExpiresAt: '2030-08-26T10:15:00.000Z',
    });
    expect(body.data.images[0]?.imageId).not.toBe(body.data.images[0]?.fileId);

    const rows = await db
      .select({ imageId: questImage.id, fileId: questImage.fileId, position: questImage.position })
      .from(questImage)
      .where(eq(questImage.questId, draft.id))
      .orderBy(questImage.position);
    expect(rows.map((row) => row.position)).toEqual([0, 1]);
    expect(rows.map((row) => row.imageId)).toEqual(body.data.images.map((image) => image.imageId));

    const replay = await postImages(draft.id, 'image-upload-1', [first, second]);
    expect(replay.status).toBe(200);
    expect((await replay.json()).data).toEqual(body.data);
    expect(upload).toHaveBeenCalledTimes(2);

    const reused = await postImages(draft.id, 'image-upload-1', [makeImageFile('different.png')]);
    expect(reused.status).toBe(409);
    expect((await reused.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(upload).toHaveBeenCalledTimes(2);

    const detail = await getQuestV2Detail(hirerId, draft.id);
    expect(detail?.images.map((image) => image.imageId)).toEqual(
      body.data.images.map((image) => image.imageId),
    );

    const detailResponse = await app.handle(
      new Request(`http://localhost/api/v2/quests/${draft.id}`, {
        headers: { cookie: sessionCookie },
      }),
    );
    expect(detailResponse.status).toBe(200);
    expect((await detailResponse.json()).data.images).toEqual(body.data.images);
    expect(await getQuestV2Detail(crypto.randomUUID(), draft.id)).toBeUndefined();
  });

  it('does not upload a duplicate object while the same idempotency key is processing', async () => {
    const draft = await createDraft();
    let releaseUpload!: () => void;
    let uploadStarted!: () => void;
    const uploadReleased = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const firstUploadStarted = new Promise<void>((resolve) => {
      uploadStarted = resolve;
    });
    const upload = spyOn(questV2Storage, 'upload').mockImplementation(async (_userId, image) => {
      uploadStarted();
      await uploadReleased;
      return {
        bucket: 'test-bucket',
        objectKey: `quests/v2/${hirerId}/${image.name}`,
        contentType: 'image/png',
        sizeBytes: image.size,
      };
    });
    spyOn(questV2Storage, 'linkForWithExpiry').mockImplementation((image) => ({
      url: `https://storage.test/${image.objectKey}`,
      expiresAt: new Date('2030-08-26T10:15:00.000Z'),
    }));

    const firstRequest = postImages(draft.id, 'image-concurrent-1', [makeImageFile('first.png')]);
    await firstUploadStarted;
    const secondResponse = await postImages(
      draft.id,
      'image-concurrent-1',
      [makeImageFile('first.png')],
    );
    releaseUpload();
    const firstResponse = await firstRequest;

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(409);
    expect((await secondResponse.json()).error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('reclaims an expired image upload reservation', async () => {
    const draft = await createDraft();
    const image = makeImageFile('expired-reservation.png');
    const key = 'image-expired-reservation';
    const requestHash = await questV2ImageUploadRequestHash(hirerId, draft.id, [image]);
    await db.insert(walletIdempotencyKey).values({
      principalUserId: hirerId,
      operationScope: questV2ImageUploadOperationScope,
      key,
      requestHash,
      expiresAt: new Date(Date.now() - 1),
    });
    spyOn(questV2Storage, 'upload').mockImplementation(async (_userId, uploadedImage) => ({
      bucket: 'test-bucket',
      objectKey: `quests/v2/${hirerId}/${uploadedImage.name}`,
      contentType: 'image/png',
      sizeBytes: uploadedImage.size,
    }));
    spyOn(questV2Storage, 'linkForWithExpiry').mockImplementation((storedImage) => ({
      url: `https://storage.test/${storedImage.objectKey}`,
      expiresAt: new Date('2030-08-26T10:15:00.000Z'),
    }));

    const response = await postImages(draft.id, key, [image]);

    expect(response.status).toBe(200);
    expect((await response.json()).data.images).toHaveLength(1);
  });

  it('removes one image, repacks positions, soft-deletes its file, and retries cleanup', async () => {
    const draft = await createDraft();
    spyOn(questV2Storage, 'upload').mockImplementation(async (_userId, image) => ({
      bucket: 'test-bucket',
      objectKey: `quests/v2/${hirerId}/${image.name}`,
      contentType: 'image/png',
      sizeBytes: image.size,
    }));
    spyOn(questV2Storage, 'linkForWithExpiry').mockImplementation((image) => ({
      url: `https://storage.test/${image.objectKey}`,
      expiresAt: new Date('2030-08-26T10:15:00.000Z'),
    }));
    const deleteObject = spyOn(questV2Storage, 'delete')
      .mockRejectedValueOnce(new Error('temporary storage failure'))
      .mockResolvedValue();

    const uploadResponse = await postImages(
      draft.id,
      'image-remove-upload',
      [makeImageFile('first.png'), makeImageFile('second.png'), makeImageFile('third.png')],
    );
    const uploadedBody = (await uploadResponse.json()) as {
      data: { images: Array<{ imageId: string; fileId: string; position: number }> };
    };
    const target = uploadedBody.data.images[1]!;

    const response = await deleteImage(draft.id, target.imageId, 'image-remove-1');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { images: Array<{ imageId: string; fileId: string; position: number }> };
    };
    expect(body.data.images.map((image) => image.imageId)).toEqual([
      uploadedBody.data.images[0]!.imageId,
      uploadedBody.data.images[2]!.imageId,
    ]);
    expect(body.data.images.map((image) => image.position)).toEqual([0, 1]);
    expect(deleteObject).toHaveBeenCalledTimes(1);

    const fileIdAsImageId = await deleteImage(draft.id, target.fileId, 'image-remove-file-id');
    expect(fileIdAsImageId.status).toBe(404);

    const [deletedFile] = await db
      .select({ deletedAt: file.deletedAt, objectDeletedAt: file.objectDeletedAt })
      .from(file)
      .where(eq(file.id, target.fileId));
    expect(deletedFile?.deletedAt).not.toBeNull();
    expect(deletedFile?.objectDeletedAt).toBeNull();

    const replay = await deleteImage(draft.id, target.imageId, 'image-remove-1');
    expect(replay.status).toBe(200);
    expect((await replay.json()).data).toEqual(body.data);
    expect(deleteObject).toHaveBeenCalledTimes(1);

    const cleanupCount = await cleanupQuestV2ImageObjects(
      new Date(deletedFile!.deletedAt!.getTime() + 1),
    );
    expect(cleanupCount).toBeGreaterThanOrEqual(1);
    expect(deleteObject).toHaveBeenCalledTimes(2);
    const [cleanedFile] = await db
      .select({ objectDeletedAt: file.objectDeletedAt })
      .from(file)
      .where(eq(file.id, target.fileId));
    expect(cleanedFile?.objectDeletedAt).not.toBeNull();
  });

  it('rejects a gallery that exceeds three images before storage upload', async () => {
    const draft = await createDraft();
    const upload = spyOn(questV2Storage, 'upload').mockImplementation(async (_userId, image) => ({
      bucket: 'test-bucket',
      objectKey: `quests/v2/${hirerId}/${image.name}`,
      contentType: 'image/png',
      sizeBytes: image.size,
    }));
    spyOn(questV2Storage, 'linkForWithExpiry').mockImplementation((image) => ({
      url: `https://storage.test/${image.objectKey}`,
      expiresAt: new Date('2030-08-26T10:15:00.000Z'),
    }));

    expect(
      (await postImages(
        draft.id,
        'image-limit-upload',
        [makeImageFile('first.png'), makeImageFile('second.png'), makeImageFile('third.png')],
      )).status,
    ).toBe(200);
    const response = await postImages(draft.id, 'image-limit-overflow', [makeImageFile('fourth.png')]);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('QUEST_IMAGE_LIMIT_REACHED');
    expect(upload).toHaveBeenCalledTimes(3);
  });

  it('rejects the whole batch and cleans earlier objects when storage fails', async () => {
    const draft = await createDraft();
    const first = {
      bucket: 'test-bucket',
      objectKey: `quests/v2/${hirerId}/first.png`,
      contentType: 'image/png' as const,
      sizeBytes: 3,
    };
    spyOn(questV2Storage, 'upload').mockResolvedValueOnce(first).mockRejectedValueOnce(
      new ImageUploadError('storage detail'),
    );
    const deleteObject = spyOn(questV2Storage, 'delete').mockResolvedValue();

    const response = await postImages(
      draft.id,
      'image-storage-failure',
      [makeImageFile('first.png'), makeImageFile('second.png')],
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      success: false,
      error: {
        code: 'QUEST_IMAGE_STORAGE_UNAVAILABLE',
        message: 'Quest Image storage is unavailable',
      },
    });
    expect(deleteObject).toHaveBeenCalledWith(first.bucket, first.objectKey);
    expect(
      await db.select({ id: questImage.id }).from(questImage).where(eq(questImage.questId, draft.id)),
    ).toEqual([]);
    expect(
      await db.select({ id: file.id }).from(file).where(eq(file.uploadedByUserId, hirerId)),
    ).toEqual([]);
  });

  it('records a cleanup tombstone when batch compensation fails', async () => {
    const draft = await createDraft();
    const first = {
      bucket: 'test-bucket',
      objectKey: `quests/v2/${hirerId}/orphan.png`,
      contentType: 'image/png' as const,
      sizeBytes: 3,
    };
    spyOn(questV2Storage, 'upload').mockResolvedValueOnce(first).mockRejectedValueOnce(
      new ImageUploadError('storage detail'),
    );
    const deleteObject = spyOn(questV2Storage, 'delete')
      .mockRejectedValueOnce(new Error('temporary cleanup failure'))
      .mockResolvedValue();

    const response = await postImages(
      draft.id,
      'image-storage-cleanup-failure',
      [makeImageFile('orphan.png'), makeImageFile('failed.png')],
    );
    expect(response.status).toBe(503);

    const [tombstone] = await db
      .select({ deletedAt: file.deletedAt, objectDeletedAt: file.objectDeletedAt })
      .from(file)
      .where(eq(file.objectKey, first.objectKey));
    expect(tombstone?.deletedAt).not.toBeNull();
    expect(tombstone?.objectDeletedAt).toBeNull();

    const cleanupCount = await cleanupQuestV2ImageObjects(
      new Date(tombstone!.deletedAt!.getTime() + 1),
    );
    expect(cleanupCount).toBe(1);
    expect(deleteObject).toHaveBeenCalledTimes(2);
    const [cleaned] = await db
      .select({ objectDeletedAt: file.objectDeletedAt })
      .from(file)
      .where(eq(file.objectKey, first.objectKey));
    expect(cleaned?.objectDeletedAt).not.toBeNull();
  });

  it('maps v2 image validation and storage failures to the documented errors', async () => {
    const draft = await createDraft();
    const upload = spyOn(questV2Storage, 'upload')
      .mockRejectedValueOnce(new ImageTooLargeError('Image is too large'))
      .mockRejectedValueOnce(new UnsupportedImageTypeError('Unsupported image'))
      .mockRejectedValueOnce(new ImageUploadError('Storage is unavailable'));

    const cases = [
      ['image-too-large', 413, 'IMAGE_TOO_LARGE'],
      ['image-unsupported', 415, 'UNSUPPORTED_IMAGE_TYPE'],
      ['image-storage-unavailable', 503, 'QUEST_IMAGE_STORAGE_UNAVAILABLE'],
    ] as const;
    for (const [key, status, code] of cases) {
      const response = await postImages(draft.id, key, [makeImageFile(`${key}.png`)]);
      expect(response.status).toBe(status);
      expect((await response.json()).error.code).toBe(code);
    }
    expect(upload).toHaveBeenCalledTimes(3);
  });

  it('enforces decoded content type and actual byte size at the HTTP boundary', async () => {
    const draft = await createDraft();
    const upload = spyOn(questV2Storage, 'upload').mockImplementation((userId, image) =>
      validatingStorage.upload(userId, image),
    );
    const validPng = await sharp({
      create: { width: 1, height: 1, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();

    const invalidContent = await postImages(
      draft.id,
      'image-http-invalid-content',
      [makeImageFile('invalid.png')],
    );
    expect(invalidContent.status).toBe(415);
    expect((await invalidContent.json()).error.code).toBe('UNSUPPORTED_IMAGE_TYPE');

    const mismatchedType = await postImages(
      draft.id,
      'image-http-mismatched-type',
      [new File([validPng], 'mismatch.jpg', { type: 'image/jpeg' })],
    );
    expect(mismatchedType.status).toBe(415);
    expect((await mismatchedType.json()).error.code).toBe('UNSUPPORTED_IMAGE_TYPE');

    const oversized = await postImages(
      draft.id,
      'image-http-actual-size',
      [new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'oversized.png', { type: 'image/png' })],
    );
    expect(oversized.status).toBe(413);
    expect((await oversized.json()).error.code).toBe('IMAGE_TOO_LARGE');
    expect(upload).toHaveBeenCalledTimes(3);
  });

  it('allows image preflight only for the owning Hirer in QUEST_DRAFT', async () => {
    const draft = await createDraft();
    const image = makeImageFile('ownership.png');
    const otherMemberId = crypto.randomUUID();
    const otherHash = await questV2ImageUploadRequestHash(otherMemberId, draft.id, [image]);
    expect(
      await checkQuestV2ImageUpload(
        otherMemberId,
        draft.id,
        1,
        'image-other-owner',
        otherHash,
      ),
    ).toEqual({ outcome: 'not-found' });

    await db
      .update(quest)
      .set({
        questStatus: 'QUEST_CANCELLED',
        rewardSatang: 2_000,
        cancelledAt: new Date(),
        cancelledByUserId: hirerId,
      })
      .where(eq(quest.id, draft.id));
    const ownerHash = await questV2ImageUploadRequestHash(hirerId, draft.id, [image]);
    expect(
      await checkQuestV2ImageUpload(hirerId, draft.id, 1, 'image-open-quest', ownerHash),
    ).toEqual({ outcome: 'not-draft' });
  });

  it('requires an Idempotency-Key before authentication for image writes', async () => {
    const form = new FormData();
    form.set('images', new File(['not-an-image'], 'quest.png', { type: 'image/png' }));

    const upload = await app.handle(
      new Request(
        'http://localhost/api/v2/quests/018f47a7-1c7d-7c98-9a11-690d7e83430c/images',
        { method: 'POST', body: form },
      ),
    );
    expect(upload.status).toBe(400);
    expect((await upload.json()).error.code).toBe('VALIDATION');

    const remove = await app.handle(
      new Request(
        'http://localhost/api/v2/quests/018f47a7-1c7d-7c98-9a11-690d7e83430c/images/018f47a7-1c7d-7c98-9a11-690d7e834301',
        { method: 'DELETE' },
      ),
    );
    expect(remove.status).toBe(400);
    expect((await remove.json()).error.code).toBe('VALIDATION');
  });

  it('documents the v2 Quest Image operations', async () => {
    const response = await app.handle(new Request('http://localhost/openapi/json'));
    const document = (await response.json()) as {
      paths: Record<string, Record<string, { operationId?: string; security?: unknown }>>;
    };

    expect(document.paths['/api/v2/quests/{questId}/images']?.post?.operationId).toBe(
      'addQuestImagesV2',
    );
    expect(document.paths['/api/v2/quests/{questId}/images/{imageId}']?.delete?.operationId).toBe(
      'deleteQuestImageV2',
    );
    expect(document.paths['/api/v2/quests/{questId}/images']?.post?.security).toEqual([
      { betterAuthSession: [] },
    ]);
    expect(
      document.paths['/api/v2/quests/{questId}/images/{imageId}']?.delete?.security,
    ).toEqual([{ betterAuthSession: [] }]);
  });
});
