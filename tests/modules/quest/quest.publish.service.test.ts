import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { quest } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import {
  createQuest,
  getQuestPublishCheck,
  publishQuest,
} from '@/modules/quest/quest.service';
import type { QuestCreateInput } from '@/modules/quest/quest.schema';

import { randomUUID } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

const hirerId = randomUUID();
const otherMemberId = randomUUID();
const tagId = randomUUID();
let questIds: string[] = [];

const baseInput: QuestCreateInput = {
  title: 'A Quest for publishing',
  description: 'A description',
  condition: 'A completed result',
  mode: 'FIRST_COME_FIRST_SERVED',
  participation: 'SINGLE',
  reward: 500,
  headcount: 1,
  startTime: '2030-08-27T10:00:00.000Z',
  dueAt: '2030-08-27T12:00:00.000Z',
  tagId,
  proofRequired: true,
  locations: [],
};

const createFixture = async (input: Partial<QuestCreateInput> = {}) => {
  const result = await createQuest(hirerId, { ...baseInput, ...input });
  if ('outcome' in result) throw new Error(`Fixture creation failed: ${result.outcome}`);

  questIds.push(result.id);
  return result.id;
};

beforeAll(async () => {
  try {
    await sql`select 1`;
  } catch (cause) {
    throw new Error('These tests need PostgreSQL. Start the local database first.', { cause });
  }

  await db.insert(authUser).values([
    {
      id: hirerId,
      email: `${hirerId}@ku.th`,
      firstName: 'Publish',
      lastName: 'Hirer',
    },
    {
      id: otherMemberId,
      email: `${otherMemberId}@ku.th`,
      firstName: 'Other',
      lastName: 'Member',
    },
  ]);
  await db.insert(tag).values({ id: tagId, name: `Publish test ${tagId}` });
});

beforeEach(async () => {
  if (questIds.length > 0) {
    await db.delete(quest).where(inArray(quest.id, questIds));
    questIds = [];
  }
});

afterAll(async () => {
  await db.delete(quest).where(inArray(quest.id, questIds));
  await db.delete(tag).where(eq(tag.id, tagId));
  await db.delete(authUser).where(inArray(authUser.id, [hirerId, otherMemberId]));
});

describe('Quest publishing service', () => {
  it('returns the publish preview for the Hirer', async () => {
    const questId = await createFixture();

    expect(await getQuestPublishCheck(hirerId, questId)).toEqual({
      blockingReasons: [],
      warnings: [
        {
          code: 'QUEST_IMAGES_MISSING',
          message: 'Quest has no images',
        },
        {
          code: 'QUEST_LOCATIONS_MISSING',
          message: 'Quest has no locations',
        },
      ],
      escrowRequirement: 500,
      canPublish: true,
    });
  });

  it('returns the first blocking reason and leaves the Quest as Draft', async () => {
    const questId = await createFixture({ tagId: null, dueAt: null });

    const result = await publishQuest(hirerId, questId);

    expect(result).toMatchObject({
      outcome: 'blocked',
      check: {
        blockingReasons: [
          {
            code: 'QUEST_TAG_REQUIRED',
            message: 'Quest requires a Tag',
          },
          {
            code: 'QUEST_DURATION_REQUIRED',
            message: 'Quest requires an estimated duration',
          },
        ],
      },
    });

    const [stored] = await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, questId));
    expect(stored?.status).toBe('DRAFT');
  });

  it('changes a valid Draft to Open', async () => {
    const questId = await createFixture();

    expect(await publishQuest(hirerId, questId)).toEqual({ outcome: 'published' });

    const [stored] = await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, questId));
    expect(stored?.status).toBe('OPEN');
  });

  it('does not expose another Member\'s Quest and rejects a non-Draft', async () => {
    const questId = await createFixture();

    expect(await getQuestPublishCheck(otherMemberId, questId)).toBeUndefined();

    await publishQuest(hirerId, questId);

    expect(await getQuestPublishCheck(hirerId, questId)).toEqual({ outcome: 'not-draft' });
    expect(await publishQuest(hirerId, questId)).toEqual({ outcome: 'not-draft' });
  });

  it('allows only one concurrent publish to win', async () => {
    const questId = await createFixture();

    const results = await Promise.all([
      publishQuest(hirerId, questId),
      publishQuest(hirerId, questId),
    ]);

    expect(results.filter((result) => result?.outcome === 'published')).toHaveLength(1);
    expect(results.filter((result) => result?.outcome === 'not-draft')).toHaveLength(1);
  });
});
