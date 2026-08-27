import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';
import { quest } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import {
  addQuestImages,
  createQuest,
  deleteQuestImage,
  getQuestDetail,
} from '@/modules/quest/quest.service';
import type { QuestCreateInput } from '@/modules/quest/quest.schema';
import type { StoredQuestImage } from '@/modules/quest/quest.storage';

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';

const hirerId = randomUUID();
const otherMemberId = randomUUID();
const tagId = randomUUID();
let questIds: string[] = [];
let objectKeyCounter = 0;

const baseInput: QuestCreateInput = {
  title: 'A Quest with images',
  description: 'A description',
  condition: 'A completed result',
  mode: 'NO_CANDIDATE',
  participation: 'SOLO',
  reward: 500,
  headcount: 1,
  startTime: '2030-08-27T10:00:00.000Z',
  dueAt: '2030-08-27T12:00:00.000Z',
  tagId,
  proofRequired: true,
  locations: [],
};

const storedImage = (name: string): StoredQuestImage => ({
  bucket: 'kuquest-test',
  objectKey: `quests/${hirerId}/${name}-${objectKeyCounter++}.png`,
  contentType: 'image/png',
  sizeBytes: 1024,
});

const createFixture = async (input: Partial<QuestCreateInput> = {}) => {
  const result = await createQuest(hirerId, { ...baseInput, ...input });
  if ('outcome' in result) throw new Error(`Fixture creation failed: ${result.outcome}`);

  questIds.push(result.id);
  return result.id;
};

const removeFixtures = async () => {
  if (questIds.length > 0) await db.delete(quest).where(inArray(quest.id, questIds));
  await db.delete(file).where(inArray(file.uploadedByUserId, [hirerId, otherMemberId]));
  questIds = [];
};

beforeAll(async () => {
  try {
    await sql`select 1`;
  } catch (cause) {
    throw new Error('These tests need PostgreSQL. Start the local database first.', { cause });
  }

  await removeFixtures();
  await db.insert(authUser).values([
    {
      id: hirerId,
      email: `${hirerId}@ku.th`,
      firstName: 'Image',
      lastName: 'Hirer',
    },
    {
      id: otherMemberId,
      email: `${otherMemberId}@ku.th`,
      firstName: 'Other',
      lastName: 'Member',
    },
  ]);
  await db.insert(tag).values({ id: tagId, name: `Image test ${tagId}` });
});

beforeEach(removeFixtures);
afterAll(async () => {
  await removeFixtures();
  await db.delete(tag).where(eq(tag.id, tagId));
  await db.delete(authUser).where(inArray(authUser.id, [hirerId, otherMemberId]));
});

describe('Quest Image persistence', () => {
  it('stores uploaded images in request order and returns their file references', async () => {
    const questId = await createFixture();
    const first = storedImage('first');
    const second = storedImage('second');

    const result = await addQuestImages(hirerId, questId, [first, second]);

    expect(result).toMatchObject({
      images: [
        { position: 0, bucket: first.bucket, objectKey: first.objectKey },
        { position: 1, bucket: second.bucket, objectKey: second.objectKey },
      ],
    });
    expect((await getQuestDetail(hirerId, questId))?.images).toMatchObject([
      { position: 0, objectKey: first.objectKey },
      { position: 1, objectKey: second.objectKey },
    ]);
  });

  it('deletes an image, repacks positions, and tombstones its file', async () => {
    const questId = await createFixture();
    const images = [storedImage('first'), storedImage('second'), storedImage('third')];
    const added = await addQuestImages(hirerId, questId, images);
    if (!('images' in added)) throw new Error('Fixture image upload failed');

    const target = added.images[1]!;
    const result = await deleteQuestImage(hirerId, questId, target.fileId);

    expect(result).toEqual({
      outcome: 'deleted',
      bucket: images[1]!.bucket,
      objectKey: images[1]!.objectKey,
    });
    expect((await getQuestDetail(hirerId, questId))?.images).toMatchObject([
      { position: 0, objectKey: images[0]!.objectKey },
      { position: 1, objectKey: images[2]!.objectKey },
    ]);

    const [deletedFile] = await db
      .select({ deletedAt: file.deletedAt })
      .from(file)
      .where(eq(file.id, target.fileId));
    expect(deletedFile?.deletedAt).not.toBeNull();
  });

  it('rejects an upload that would exceed the three-image cap without storing it', async () => {
    const questId = await createFixture();
    await addQuestImages(hirerId, questId, [storedImage('first'), storedImage('second')]);
    const before = await db
      .select({ id: file.id })
      .from(file)
      .where(eq(file.uploadedByUserId, hirerId));

    const result = await addQuestImages(hirerId, questId, [
      storedImage('third'),
      storedImage('overflow'),
    ]);

    expect(result).toEqual({ outcome: 'limit-reached' });
    expect(
      await db.select({ id: file.id }).from(file).where(eq(file.uploadedByUserId, hirerId)),
    ).toHaveLength(before.length);
    expect((await getQuestDetail(hirerId, questId))?.images).toHaveLength(2);
  });

  it('hides a Hirer Quest from another Member and rejects image changes after Draft', async () => {
    const questId = await createFixture();

    expect(await addQuestImages(otherMemberId, questId, [storedImage('not-owned')])).toEqual({
      outcome: 'not-found',
    });

    await db.update(quest).set({ questStatus: 'QUEST_OPEN' }).where(eq(quest.id, questId));

    expect(await addQuestImages(hirerId, questId, [storedImage('not-editable')])).toEqual({
      outcome: 'not-editable',
    });
  });

  it('does not delete an image belonging to another Quest', async () => {
    const firstQuestId = await createFixture({ title: 'First Quest' });
    const secondQuestId = await createFixture({ title: 'Second Quest' });
    const added = await addQuestImages(hirerId, secondQuestId, [storedImage('other-quest')]);
    if (!('images' in added)) throw new Error('Fixture image upload failed');

    expect(await deleteQuestImage(hirerId, firstQuestId, added.images[0]!.fileId)).toEqual({
      outcome: 'not-found',
    });
    expect((await getQuestDetail(hirerId, secondQuestId))?.images).toHaveLength(1);
  });

  it('does not delete an image after the Quest becomes OPEN', async () => {
    const questId = await createFixture();
    const added = await addQuestImages(hirerId, questId, [storedImage('published')]);
    if (!('images' in added)) throw new Error('Fixture image upload failed');

    await db.update(quest).set({ questStatus: 'QUEST_OPEN' }).where(eq(quest.id, questId));

    expect(await deleteQuestImage(hirerId, questId, added.images[0]!.fileId)).toEqual({
      outcome: 'not-editable',
    });
    expect((await getQuestDetail(hirerId, questId))?.images).toHaveLength(1);
  });
});
