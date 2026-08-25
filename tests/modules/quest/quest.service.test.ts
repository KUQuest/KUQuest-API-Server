import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { quest } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import {
  createQuest,
  getQuestDetail,
  listBoardQuests,
  listOwnQuests,
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
  title: 'A Quest for testing',
  description: 'A description',
  condition: 'A completed result',
  mode: 'FIRST_COME_FIRST_SERVED' as const,
  participation: 'SINGLE' as const,
  reward: 500,
  headcount: 1,
  startTime: '2026-08-26T10:00:00.000Z',
  dueAt: '2026-08-26T12:00:00.000Z',
  proofRequired: true,
  locations: [],
};

const createFixture = async (
  input: Partial<QuestCreateInput> = {},
) => {
  const result = await createQuest(hirerId, { ...baseInput, ...input });
  if ('outcome' in result) throw new Error(`Fixture creation failed: ${result.outcome}`);

  questIds.push(result.id);
  return result.id;
};

const openQuest = async (questId: string) => {
  await db
    .update(quest)
    .set({ questStatus: 'OPEN', tagId })
    .where(eq(quest.id, questId));
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
      firstName: 'Quest',
      lastName: 'Hirer',
    },
    {
      id: otherMemberId,
      email: `${otherMemberId}@ku.th`,
      firstName: 'Other',
      lastName: 'Member',
    },
  ]);
  await db.insert(tag).values({ id: tagId, name: `Quest test ${tagId}` });
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

describe('Quest persistence', () => {
  it('creates a private Draft and returns full detail to its Hirer', async () => {
    const questId = await createFixture({
      reward: 250,
      locations: [
        {
          label: 'First place',
          address: 'Kasetsart University',
          latitude: 13.8478,
          longitude: 100.5714,
        },
      ],
    });

    const detail = await getQuestDetail(hirerId, questId);

    expect(detail).toMatchObject({
      id: questId,
      reward: 250,
      questStatus: 'DRAFT',
      estimatedDurationMinutes: 120,
      locations: [
        {
          label: 'First place',
          address: 'Kasetsart University',
          position: 1,
        },
      ],
    });
  });

  it('hides a private Draft from another Member and exposes only OPEN detail', async () => {
    const questId = await createFixture();

    expect(await getQuestDetail(otherMemberId, questId)).toBeUndefined();

    await openQuest(questId);

    expect((await getQuestDetail(otherMemberId, questId))?.questStatus).toBe('OPEN');
  });

  it('lists the Hirer’s Quests across Quest Status values', async () => {
    const draftId = await createFixture({ title: 'Draft Quest' });
    const openId = await createFixture({ title: 'Open Quest' });
    await openQuest(openId);

    const result = await listOwnQuests(hirerId, { limit: 20 });

    expect(result.items.map((item) => item.id)).toEqual(expect.arrayContaining([draftId, openId]));
    expect(result.items.find((item) => item.id === draftId)?.questStatus).toBe('DRAFT');
    expect(result.items.find((item) => item.id === openId)?.questStatus).toBe('OPEN');
  });

  it('returns only OPEN Quests and supports Thai substring search', async () => {
    const openId = await createFixture({ title: 'เควส ออกแบบ', description: 'งานภาษาไทย' });
    const draftId = await createFixture({ title: 'เควส Draft', description: 'งานภาษาไทย' });
    await openQuest(openId);

    const result = await listBoardQuests({ q: 'ภาษาไทย', limit: 20 });

    expect(result.items.map((item) => item.id)).toEqual([openId]);
    expect(result.items.map((item) => item.id)).not.toContain(draftId);
  });

  it('uses the approved total cursor order without repeats', async () => {
    const ids = await Promise.all([
      createFixture({ title: 'cursor-test one' }),
      createFixture({ title: 'cursor-test two' }),
      createFixture({ title: 'cursor-test three' }),
    ]);
    await Promise.all(ids.map(openQuest));

    const firstPage = await listBoardQuests({ q: 'cursor-test', limit: 2 });
    const secondPage = await listBoardQuests({
      q: 'cursor-test',
      limit: 2,
      cursor: firstPage.nextCursor ?? undefined,
    });
    const returnedIds = [...firstPage.items, ...secondPage.items].map((item) => item.id);

    expect(new Set(returnedIds).size).toBe(returnedIds.length);
    expect(returnedIds).toEqual(expect.arrayContaining(ids));
    expect(secondPage.nextCursor).toBeNull();
  });
});
