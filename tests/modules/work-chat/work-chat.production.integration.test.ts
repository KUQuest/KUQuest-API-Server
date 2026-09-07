import { createApp } from '@/app';
import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import {
  quest,
  questApplication,
  questAssignment,
} from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import {
  chatConversation,
  chatMembership,
  chatMessage,
  chatTransitionCommand,
} from '@/database/schema/work-chat.schema';
import { auth } from '@/modules/auth';
import { configureQuestWorkChatMembershipWriter } from '@/modules/quest';

import { randomUUID } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

const hirerId = randomUUID();
const workerIds = [randomUUID(), randomUUID()];
const tagId = randomUUID();
const questIds: string[] = [];
let postgresAvailable = false;
// The composed route tree is past what TypeScript will instantiate through
// `ReturnType<typeof createApp>`, and these tests only drive the app through `handle`.
let productionApp: { handle: (request: Request) => Promise<Response> };

const createQuest = async (mode: 'NO_CANDIDATE' | 'CANDIDATE') => {
  const questId = randomUUID();
  questIds.push(questId);
  await db.insert(quest).values({
    id: questId,
    hirerId,
    title: 'Production Work Conversation test',
    condition: 'Complete the work',
    mode,
    participation: 'SOLO',
    questStatus: 'QUEST_OPEN',
    rewardSatang: 500,
    tagId,
    headcount: 1,
    startTime: new Date('2030-01-01T10:00:00.000Z'),
  });
  return questId;
};

const authenticate = () => spyOn(auth.api, 'getSession').mockImplementation((async (
  { headers }: { headers: Headers },
) => {
  const memberId = headers.get('x-member-id') ?? hirerId;
  return { user: { id: memberId }, session: { userId: memberId } } as never;
}) as never);

const post = (path: string, memberId: string, commandId: string) => productionApp.handle(
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      'idempotency-key': commandId,
      'x-member-id': memberId,
    },
  }),
);

const cleanQuests = async (): Promise<void> => {
  if (!postgresAvailable || questIds.length === 0) return;
  await db.delete(chatTransitionCommand).where(inArray(chatTransitionCommand.questId, questIds));
  const conversations = await db.select({ id: chatConversation.id })
    .from(chatConversation)
    .where(inArray(chatConversation.questId, questIds));
  const conversationIds = conversations.map(({ id }) => id);
  if (conversationIds.length > 0) {
    await db.delete(chatMessage).where(inArray(chatMessage.conversationId, conversationIds));
    await db.delete(chatMembership).where(inArray(chatMembership.conversationId, conversationIds));
    await db.delete(chatConversation).where(inArray(chatConversation.id, conversationIds));
  }
  await db.delete(quest).where(inArray(quest.id, questIds));
  questIds.length = 0;
};

beforeAll(async () => {
  try {
    await sql`select 1`;
    postgresAvailable = true;
  } catch {
    return;
  }
  await db.insert(authUser).values([
    { id: hirerId, email: `${hirerId}@ku.th`, firstName: 'Production', lastName: 'Hirer' },
    ...workerIds.map((id, index) => ({
      id,
      email: `${id}@ku.th`,
      firstName: 'Production',
      lastName: `Worker ${index}`,
    })),
  ]);
  await db.insert(tag).values({ id: tagId, name: `Production Work Chat ${tagId}` });
});

beforeEach(() => {
  productionApp = createApp();
});

afterEach(async () => {
  configureQuestWorkChatMembershipWriter(undefined);
  mock.restore();
  await cleanQuests();
});

afterAll(async () => {
  if (!postgresAvailable) return;
  await db.delete(tag).where(eq(tag.id, tagId));
  await db.delete(authUser).where(inArray(authUser.id, [hirerId, ...workerIds]));
});

describe('production Work Conversation composition', () => {
  it('writes direct join and Candidate selection through the real production writer', async () => {
    if (!postgresAvailable) return;
    authenticate();
    const commandId = 'shared-production-command';
    const directQuestId = await createQuest('NO_CANDIDATE');
    const candidateQuestId = await createQuest('CANDIDATE');
    const applicationId = randomUUID();
    await db.insert(questApplication).values({
      id: applicationId,
      questId: candidateQuestId,
      workerId: workerIds[1],
      applicationStatus: 'APPLICATION_APPLIED',
    });

    const direct = await post(`/api/v1/quests/${directQuestId}/join`, workerIds[0]!, commandId);
    const selected = await post(
      `/api/v1/quests/${candidateQuestId}/applications/${applicationId}/select`,
      hirerId,
      commandId,
    );

    expect(direct.status).toBe(200);
    expect(selected.status).toBe(200);
    const conversations = await db.select().from(chatConversation)
      .where(inArray(chatConversation.questId, [directQuestId, candidateQuestId]));
    expect(conversations).toHaveLength(2);
    const memberships = await db.select().from(chatMembership)
      .where(inArray(chatMembership.conversationId, conversations.map(({ id }) => id)));
    expect(memberships).toHaveLength(4);
    expect(memberships.filter(({ role }) => role === 'WORKER')).toHaveLength(2);
  });

  it('rolls back Candidate selection when the configured writer fails', async () => {
    if (!postgresAvailable) return;
    authenticate();
    const candidateQuestId = await createQuest('CANDIDATE');
    const applicationId = randomUUID();
    await db.insert(questApplication).values({
      id: applicationId,
      questId: candidateQuestId,
      workerId: workerIds[0],
      applicationStatus: 'APPLICATION_APPLIED',
    });
    configureQuestWorkChatMembershipWriter({
      applyQuestTransition: async () => {
        throw new Error('Work Chat unavailable');
      },
    });

    const response = await post(
      `/api/v1/quests/${candidateQuestId}/applications/${applicationId}/select`,
      hirerId,
      'candidate-production-rollback',
    );

    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('WORK_CHAT_UNAVAILABLE');
    expect(await db.select().from(questAssignment).where(eq(questAssignment.questId, candidateQuestId))).toHaveLength(0);
    const [currentQuest] = await db.select({ status: quest.questStatus })
      .from(quest)
      .where(eq(quest.id, candidateQuestId));
    expect(currentQuest?.status).toBe('QUEST_OPEN');
  });
});
