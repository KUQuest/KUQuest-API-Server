import { db, sql } from '@/database/client';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import {
  quest,
  questApplication,
  questAssignment,
  questEditHistory,
  questTeam,
} from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import {
  createQuest,
  editQuest,
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
const adminId = randomUUID();
const tagId = randomUUID();
let questIds: string[] = [];

const baseInput: QuestCreateInput = {
  title: 'A Quest for testing',
  description: 'A description',
  condition: 'A completed result',
  mode: 'NO_CANDIDATE' as const,
  participation: 'SOLO' as const,
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
    .set({ questStatus: 'QUEST_OPEN', tagId })
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
  await db.insert(authAdmin).values({
    id: adminId,
    email: `${adminId}@kuquest.test`,
    firstName: 'Quest',
    lastName: 'Admin',
  });
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
  await db.delete(authAdmin).where(eq(authAdmin.id, adminId));
  await db.delete(authUser).where(inArray(authUser.id, [hirerId, otherMemberId]));
});

describe('Quest persistence', () => {
  it('creates a private Draft and returns full detail to its Hirer', async () => {
    const questId = await createFixture({
      reward: 250,
      locations: [
        {
          label: 'First place',
        },
      ],
    });

    const detail = await getQuestDetail(hirerId, questId);

    expect(detail).toMatchObject({
      id: questId,
      reward: 250,
      questStatus: 'QUEST_DRAFT',
      estimatedDurationMinutes: 120,
      locations: [
        {
          label: 'First place',
        },
      ],
    });
  });

  it('hides a private Draft from another Member and exposes only OPEN detail', async () => {
    const questId = await createFixture();

    expect(await getQuestDetail(otherMemberId, questId)).toBeUndefined();

    await openQuest(questId);

    expect((await getQuestDetail(otherMemberId, questId))?.questStatus).toBe('QUEST_OPEN');
  });
  it('marks a hidden Quest in Hirer views without exposing it to other Members', async () => {
    const questId = await createFixture();
    await openQuest(questId);
    await db.update(quest).set({
      hiddenAt: new Date(),
      hiddenByAdminId: adminId,
    }).where(eq(quest.id, questId));

    const detail = await getQuestDetail(hirerId, questId);
    expect(detail?.hiddenAt).toEqual(expect.any(String));
    const mine = await listOwnQuests(hirerId, { limit: 20 });
    expect(mine.items.find((item) => item.id === questId)?.hiddenAt).toEqual(expect.any(String));
    expect(await getQuestDetail(otherMemberId, questId)).toBeUndefined();
  });

  it('allows an Active Worker to view an assigned Quest and hides it from unrelated Members', async () => {
    const questId = await createFixture();
    await openQuest(questId);
    await db.update(quest).set({ questStatus: 'QUEST_ASSIGNED' }).where(eq(quest.id, questId));
    await db.insert(questAssignment).values({
      questId,
      workerId: otherMemberId,
      assignmentStatus: 'ASSIGNMENT_ACTIVE',
    });

    expect((await getQuestDetail(otherMemberId, questId))?.questStatus).toBe('QUEST_ASSIGNED');
    expect(await getQuestDetail(randomUUID(), questId)).toBeUndefined();
  });

  it('lists the Hirer’s Quests across Quest Status values', async () => {
    const draftId = await createFixture({ title: 'Draft Quest' });
    const openId = await createFixture({ title: 'Open Quest' });
    await openQuest(openId);

    const result = await listOwnQuests(hirerId, { limit: 20 });

    expect(result.items.map((item) => item.id)).toEqual(expect.arrayContaining([draftId, openId]));
    expect(result.items.find((item) => item.id === draftId)?.questStatus).toBe('QUEST_DRAFT');
    expect(result.items.find((item) => item.id === openId)?.questStatus).toBe('QUEST_OPEN');
  });

  it('returns only OPEN Quests and supports Thai substring search', async () => {
    const openId = await createFixture({ title: 'เควส ออกแบบ', description: 'งานภาษาไทย' });
    const draftId = await createFixture({ title: 'เควส Draft', description: 'งานภาษาไทย' });
    await openQuest(openId);

    const result = await listBoardQuests({ q: 'ภาษาไทย', limit: 20 });

    expect(result.items.map((item) => item.id)).toEqual([openId]);
    expect(result.items.map((item) => item.id)).not.toContain(draftId);
  });

  it('uses whole-minute duration consistently for Board filtering', async () => {
    const questId = await createFixture({
      title: 'duration-test',
      startTime: '2026-08-26T10:00:00.000Z',
      dueAt: '2026-08-26T10:01:01.000Z',
    });
    await openQuest(questId);

    const result = await listBoardQuests({
      q: 'duration-test',
      maxDurationMinutes: 1,
      limit: 20,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.estimatedDurationMinutes).toBe(1);
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

  it('edits an OPEN Quest before participation and records field-level history', async () => {
    const questId = await createFixture({
      title: 'Before the edit',
      description: 'Old description',
      locations: [
        {
          label: 'Old place',
        },
      ],
    });
    await openQuest(questId);

    const result = await editQuest(hirerId, questId, {
      title: 'After the edit',
      description: 'New description',
      locations: [
        {
          label: 'New place',
        },
      ],
    });

    expect(result).toEqual({ id: questId });
    expect(await getQuestDetail(hirerId, questId)).toMatchObject({
      id: questId,
      title: 'After the edit',
      description: 'New description',
      condition: baseInput.condition,
      locations: [
        {
          label: 'New place',
        },
      ],
    });

    const history = await db
      .select({
        fieldName: questEditHistory.fieldName,
        oldValue: questEditHistory.oldValue,
        newValue: questEditHistory.newValue,
      })
      .from(questEditHistory)
      .where(eq(questEditHistory.questId, questId));

    expect(history).toEqual([
      { fieldName: 'title', oldValue: 'Before the edit', newValue: 'After the edit' },
      { fieldName: 'description', oldValue: 'Old description', newValue: 'New description' },
      {
        fieldName: 'locations',
        oldValue: [
          {
            label: 'Old place',
          },
        ],
        newValue: [
          {
            label: 'New place',
          },
        ],
      },
    ]);
  });

  it('rejects changes to core Quest commitments after publish', async () => {
    const questId = await createFixture();
    await openQuest(questId);

    expect(await editQuest(hirerId, questId, { tagId: null })).toEqual({
      outcome: 'forbidden-fields',
    });
  });

  it('lets the Hirer add a Tag to a null-tag Draft', async () => {
    const questId = await createFixture();

    expect(await editQuest(hirerId, questId, { tagId })).toEqual({ id: questId });
    expect((await getQuestDetail(hirerId, questId))?.tag).toEqual({
      id: tagId,
      name: `Quest test ${tagId}`,
    });
  });

  it('rejects an empty edit after confirming that a Draft is editable', async () => {
    const questId = await createFixture();

    expect(await editQuest(hirerId, questId, {})).toEqual({ outcome: 'empty-edit' });
  });

  it('treats another Member’s Quest as not found when editing', async () => {
    const questId = await createFixture();

    expect(await editQuest(otherMemberId, questId, { title: 'Not allowed' })).toEqual({
      outcome: 'not-found',
    });
  });

  it('checks Quest existence before rejecting an empty edit', async () => {
    expect(await editQuest(hirerId, randomUUID(), {})).toEqual({ outcome: 'not-found' });
  });

  it('rejects direct edits when a Candidate exists', async () => {
    const questId = await createFixture({ mode: 'CANDIDATE' });
    await openQuest(questId);
    await db.insert(questApplication).values({
      questId,
      workerId: otherMemberId,
    });

    expect(await editQuest(hirerId, questId, { title: 'Candidate Quest edit' })).toEqual({
      outcome: 'not-editable',
    });
  });

  it('requires consent after a Worker has been selected', async () => {
    const questId = await createFixture({ mode: 'CANDIDATE' });
    await openQuest(questId);
    await db.insert(questApplication).values({
      questId,
      workerId: otherMemberId,
      applicationStatus: 'APPLICATION_SELECTED',
    });

    expect(await editQuest(hirerId, questId, { title: 'Selected Worker edit' })).toEqual({
      outcome: 'requires-consent',
    });
  });

  it('requires consent while an Assignment is active', async () => {
    const questId = await createFixture();
    await openQuest(questId);
    await db.insert(questAssignment).values({
      questId,
      workerId: otherMemberId,
    });

    expect(await editQuest(hirerId, questId, { title: 'Active Worker edit' })).toEqual({
      outcome: 'requires-consent',
    });
  });

  it('requires consent after a Team has been selected', async () => {
    const questId = await createFixture({ participation: 'GROUP', headcount: 2 });
    await openQuest(questId);
    await db.insert(questTeam).values({
      questId,
      leaderId: otherMemberId,
      name: 'Selected Team',
      teamStatus: 'TEAM_SELECTED',
    });

    expect(await editQuest(hirerId, questId, { title: 'Selected Team edit' })).toEqual({
      outcome: 'requires-consent',
    });
  });

  it('rejects an empty edit request', async () => {
    const questId = await createFixture();
    await openQuest(questId);

    expect(await editQuest(hirerId, questId, {})).toEqual({ outcome: 'empty-edit' });
  });

  it('does not create history for a no-op edit', async () => {
    const questId = await createFixture();
    await openQuest(questId);

    expect(await editQuest(hirerId, questId, { title: baseInput.title })).toEqual({
      id: questId,
    });
    expect(
      await db
        .select({ id: questEditHistory.id })
        .from(questEditHistory)
        .where(eq(questEditHistory.questId, questId)),
    ).toHaveLength(0);
  });

  it('does not create location history for unchanged label values', async () => {
    const questId = await createFixture({
      locations: [
        {
          label: 'Stored place',
        },
      ],
    });
    await openQuest(questId);

    expect(
      await editQuest(hirerId, questId, {
        locations: [
          {
            label: 'Stored place',
          },
        ],
      }),
    ).toEqual({ id: questId });
    expect(
      await db
        .select({ id: questEditHistory.id })
        .from(questEditHistory)
        .where(eq(questEditHistory.questId, questId)),
    ).toHaveLength(0);
  });

  it('replaces locations with an empty array and records the clear', async () => {
    const questId = await createFixture({
      locations: [
        {
          label: 'Place to clear',
        },
      ],
    });
    await openQuest(questId);

    expect(await editQuest(hirerId, questId, { locations: [] })).toEqual({ id: questId });
    expect((await getQuestDetail(hirerId, questId))?.locations).toEqual([]);

    const [history] = await db
      .select({ oldValue: questEditHistory.oldValue, newValue: questEditHistory.newValue })
      .from(questEditHistory)
      .where(eq(questEditHistory.questId, questId));

    expect(history).toEqual({
      oldValue: [
        {
          label: 'Place to clear',
        },
      ],
      newValue: [],
    });
  });

  it('rejects clearing the Tag required by an OPEN Quest', async () => {
    const questId = await createFixture();
    await openQuest(questId);

    expect(await editQuest(hirerId, questId, { tagId: null })).toEqual({
      outcome: 'forbidden-fields',
    });
  });

  it('does not persist earlier fields when a later Tag validation fails', async () => {
    const questId = await createFixture({ title: 'Original title' });
    await openQuest(questId);

    expect(
      await editQuest(hirerId, questId, {
        title: 'Should not persist',
        tagId: randomUUID(),
      }),
    ).toEqual({ outcome: 'forbidden-fields' });
    expect((await getQuestDetail(hirerId, questId))?.title).toBe('Original title');
    expect(
      await db
        .select({ id: questEditHistory.id })
        .from(questEditHistory)
        .where(eq(questEditHistory.questId, questId)),
    ).toHaveLength(0);
  });

  it('rejects an edit that makes the Quest dates invalid', async () => {
    const questId = await createFixture();
    await openQuest(questId);

    expect(
      await editQuest(hirerId, questId, { startTime: '2026-08-26T13:00:00.000Z' }),
    ).toEqual({ outcome: 'invalid-dates' });
  });

  it('rejects an edit with a missing Tag', async () => {
    const questId = await createFixture();
    await openQuest(questId);

    expect(await editQuest(hirerId, questId, { tagId: randomUUID() })).toEqual({
      outcome: 'forbidden-fields',
    });
  });
});
