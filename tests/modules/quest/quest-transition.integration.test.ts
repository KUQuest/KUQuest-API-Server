import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { quest } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import type { QuestWorkChatMembershipTransition } from '@/modules/quest/shared';
import { applyQuestStateTransition, QuestTransitionNotAllowedError } from '@/modules/quest/shared';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

let postgresAvailable = false;
const hirerId = randomUUID();
const tagId = randomUUID();
const questIds: string[] = [];

const createQuest = async (questStatus: 'QUEST_DRAFT' | 'QUEST_IN_PROGRESS') => {
  const questId = randomUUID();
  questIds.push(questId);
  await db.insert(quest).values({
    id: questId,
    hirerId,
    title: 'Transition test',
    condition: 'Complete the work',
    mode: 'NO_CANDIDATE',
    participation: 'SOLO',
    questStatus,
    rewardSatang: 1_000,
    headcount: 1,
    tagId,
    startTime: new Date('2030-01-01T10:00:00.000Z'),
  });
  return questId;
};

const readQuest = async (questId: string) =>
  (
    await db
      .select({
        questStatus: quest.questStatus,
        version: quest.version,
        failedAt: quest.failedAt,
      })
      .from(quest)
      .where(eq(quest.id, questId))
  )[0]!;

const closure = (questId: string): QuestWorkChatMembershipTransition => ({
  producer: 'QUEST_SETTLEMENT',
  type: 'workerBecameInactive',
  commandId: `closure-${questId}`,
  eventId: `closure-${questId}`,
  questId,
  actorId: hirerId,
  occurredAt: new Date().toISOString(),
  assignmentId: randomUUID(),
  workerId: hirerId,
  assignmentStatus: 'ASSIGNMENT_INCOMPLETE',
  leftAt: new Date().toISOString(),
});

const readOnlyEntry = (questId: string): QuestWorkChatMembershipTransition => ({
  producer: 'QUEST_SETTLEMENT',
  type: 'questBecameReadOnly',
  commandId: `read-only-${questId}`,
  eventId: `read-only-${questId}`,
  questId,
  actorId: hirerId,
  occurredAt: new Date().toISOString(),
  questStatus: 'QUEST_FAILED',
  readOnlyAt: new Date().toISOString(),
});

beforeAll(async () => {
  try {
    await sql`select 1`;
    postgresAvailable = true;
  } catch {
    return;
  }
  await db
    .insert(authUser)
    .values({ id: hirerId, email: `${hirerId}@ku.th`, firstName: 'Transition', lastName: 'Hirer' });
  await db.insert(tag).values({ id: tagId, name: `Transition test ${tagId}` });
});

afterAll(async () => {
  if (!postgresAvailable) return;
  for (const questId of questIds) await db.delete(quest).where(eq(quest.id, questId));
  await db.delete(tag).where(eq(tag.id, tagId));
  await db.delete(authUser).where(eq(authUser.id, hirerId));
});

describe('Quest State transition module', () => {
  it('refuses a Quest State pair the lifecycle does not allow', async () => {
    if (!postgresAvailable) return;
    const questId = await createQuest('QUEST_DRAFT');
    await expect(
      db.transaction((transaction) =>
        applyQuestStateTransition(transaction, {
          questId,
          from: 'QUEST_DRAFT',
          to: 'QUEST_COMPLETED',
          now: new Date(),
          workChat: [],
        })
      )
    ).rejects.toBeInstanceOf(QuestTransitionNotAllowedError);
    expect(await readQuest(questId)).toMatchObject({ questStatus: 'QUEST_DRAFT', version: 1 });
  });

  it('closes memberships before the State write and records read-only access after it', async () => {
    if (!postgresAvailable) return;
    const questId = await createQuest('QUEST_IN_PROGRESS');
    const seen: { type: string; questStatus: string }[] = [];
    const applied = await db.transaction((transaction) =>
      applyQuestStateTransition(transaction, {
        questId,
        from: 'QUEST_IN_PROGRESS',
        to: 'QUEST_FAILED',
        now: new Date('2030-02-02T10:00:00.000Z'),
        workChat: [closure(questId), readOnlyEntry(questId)],
        writer: {
          applyQuestTransition: async (tx, transition) => {
            const [row] = await tx
              .select({ questStatus: quest.questStatus })
              .from(quest)
              .where(eq(quest.id, questId));
            seen.push({ type: transition.type, questStatus: row!.questStatus });
            return { conversationId: 'test-conversation', outcome: 'APPLIED' };
          },
        },
      })
    );

    expect(applied).toBe(true);
    expect(seen).toEqual([
      { type: 'workerBecameInactive', questStatus: 'QUEST_IN_PROGRESS' },
      { type: 'questBecameReadOnly', questStatus: 'QUEST_FAILED' },
    ]);
    const row = await readQuest(questId);
    expect(row.questStatus).toBe('QUEST_FAILED');
    expect(row.version).toBe(2);
    expect(row.failedAt).not.toBeNull();
  });

  it('answers false and writes nothing when another transaction moved the Quest first', async () => {
    if (!postgresAvailable) return;
    const questId = await createQuest('QUEST_IN_PROGRESS');
    const applied = await db.transaction((transaction) =>
      applyQuestStateTransition(transaction, {
        questId,
        from: 'QUEST_IN_PROGRESS',
        to: 'QUEST_FAILED',
        now: new Date('2030-02-02T10:00:00.000Z'),
        version: 99,
        workChat: [],
      })
    );

    expect(applied).toBe(false);
    expect(await readQuest(questId)).toMatchObject({
      questStatus: 'QUEST_IN_PROGRESS',
      version: 1,
      failedAt: null,
    });
  });
});
