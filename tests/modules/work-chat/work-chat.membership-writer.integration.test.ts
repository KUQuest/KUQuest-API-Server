import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { quest, questAssignment } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import {
  chatConversation,
  chatMembership,
  chatMessage,
  chatTransitionCommand,
} from '@/database/schema/work-chat.schema';
import { createWorkChatMembershipWriter } from '@/modules/work-chat';
import type {
  AcceptedWorker,
  QuestWorkChatMembershipTransition,
} from '@/modules/quest';

import { randomUUID } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

let postgresAvailable = false;
const hirerId = randomUUID();
const workerIds = [randomUUID(), randomUUID(), randomUUID()];
const questId = randomUUID();
const tagId = randomUUID();
const assignmentIds = [randomUUID(), randomUUID(), randomUUID()];
const writer = createWorkChatMembershipWriter();

const acceptedTransition = (
  commandId: string,
  eventId: string,
  workers: Array<{ workerId: string; assignmentId: string; joinedAt: string }>,
): QuestWorkChatMembershipTransition => ({
  producer: 'QUEST_DIRECT_JOIN',
  type: 'workersAccepted',
  commandId,
  eventId,
  questId,
  actorId: workers[0]?.workerId ?? null,
  hirerId,
  occurredAt: workers[0]?.joinedAt ?? '2030-01-01T10:00:00.000Z',
  workers: workers as [AcceptedWorker, ...AcceptedWorker[]],
});

beforeAll(async () => {
  try {
    await sql`select 1`;
    postgresAvailable = true;
  } catch {
    return;
  }

  await db.insert(authUser).values([
    { id: hirerId, email: `${hirerId}@ku.th`, firstName: 'Chat', lastName: 'Hirer' },
    ...workerIds.map((id, index) => ({
      id,
      email: `${id}@ku.th`,
      firstName: 'Chat',
      lastName: `Worker ${index}`,
    })),
  ]);
  await db.insert(tag).values({ id: tagId, name: `Work Chat test ${tagId}` });
  await db.insert(quest).values({
    id: questId,
    hirerId,
    title: 'Work Conversation test',
    condition: 'Complete the test work',
    mode: 'NO_CANDIDATE',
    participation: 'GROUP',
    questStatus: 'QUEST_OPEN',
    rewardSatang: 500,
    tagId,
    headcount: 2,
    startTime: new Date('2030-01-01T10:00:00.000Z'),
  });
  await db.insert(questAssignment).values(assignmentIds.map((id, index) => ({
    id,
    questId,
    workerId: workerIds[index]!,
    assignmentStatus: 'ASSIGNMENT_ACTIVE',
    createdAt: new Date(`2030-01-01T10:0${index}:00.000Z`),
  })));
});

afterAll(async () => {
  if (!postgresAvailable) return;
  await db.delete(chatTransitionCommand).where(eq(chatTransitionCommand.questId, questId));
  const [conversation] = await db.select({ id: chatConversation.id }).from(chatConversation).where(eq(chatConversation.questId, questId));
  if (conversation) {
    await db.delete(chatMessage).where(eq(chatMessage.conversationId, conversation.id));
    await db.delete(chatMembership).where(eq(chatMembership.conversationId, conversation.id));
    await db.delete(chatConversation).where(eq(chatConversation.id, conversation.id));
  }
  await db.delete(questAssignment).where(inArray(questAssignment.id, assignmentIds));
  await db.delete(quest).where(eq(quest.id, questId));
  await db.delete(tag).where(eq(tag.id, tagId));
  await db.delete(authUser).where(inArray(authUser.id, [hirerId, ...workerIds]));
});

describe('WorkChatMembershipWriter', () => {
  it('creates one Conversation, opens windows, records System Messages, and deduplicates retries', async () => {
    if (!postgresAvailable) return;
    const firstJoinedAt = '2030-01-01T10:00:00.000Z';
    const first = acceptedTransition('chat-accept-1', 'chat-event-1', [{
      workerId: workerIds[0]!,
      assignmentId: assignmentIds[0]!,
      joinedAt: firstJoinedAt,
    }]);

    const created = await db.transaction((transaction) => writer.applyQuestTransition(transaction, first));
    expect(created.outcome).toBe('APPLIED');

    const retry = await db.transaction((transaction) => writer.applyQuestTransition(transaction, first));
    expect(retry).toEqual({ conversationId: created.conversationId, outcome: 'ALREADY_APPLIED' });

    await expect(db.transaction((transaction) => writer.applyQuestTransition(transaction, {
      ...first,
      eventId: 'chat-event-reused-with-different-request',
    }))).rejects.toThrow('request identity');

    const second = acceptedTransition('chat-accept-2', 'chat-event-2', [{
      workerId: workerIds[1]!,
      assignmentId: assignmentIds[1]!,
      joinedAt: '2030-01-01T10:01:00.000Z',
    }]);
    await db.transaction((transaction) => writer.applyQuestTransition(transaction, second));

    const memberships = await db.select().from(chatMembership).where(eq(chatMembership.conversationId, created.conversationId));
    const messages = await db.select().from(chatMessage).where(eq(chatMessage.conversationId, created.conversationId));
    expect(memberships).toHaveLength(3);
    expect(memberships.filter(({ role }) => role === 'WORKER')).toHaveLength(2);
    expect(messages).toHaveLength(3);
    expect(new Set(messages.map(({ eventId }) => eventId)).size).toBe(3);
  });

  it('rejects an Assignment whose Worker does not match the transition', async () => {
    if (!postgresAvailable) return;
    const malformed = acceptedTransition('chat-accept-malformed', 'chat-event-malformed', [{
      workerId: workerIds[0]!,
      assignmentId: assignmentIds[2]!,
      joinedAt: '2030-01-01T10:02:00.000Z',
    }]);

    await expect(db.transaction((transaction) =>
      writer.applyQuestTransition(transaction, malformed),
    )).rejects.toThrow('does not belong to the transition Quest and Worker');

    const inactiveAssignment = acceptedTransition('chat-accept-inactive', 'chat-event-inactive', [{
      workerId: workerIds[2]!,
      assignmentId: assignmentIds[2]!,
      joinedAt: '2030-01-01T10:02:00.000Z',
    }]);
    await expect(db.transaction(async (transaction) => {
      await transaction.update(questAssignment)
        .set({ assignmentStatus: 'ASSIGNMENT_CANCELLED' })
        .where(eq(questAssignment.id, assignmentIds[2]!));
      return writer.applyQuestTransition(transaction, inactiveAssignment);
    })).rejects.toThrow('Active Assignment');
  });

  it('closes the Worker window and makes a terminal Conversation read-only once', async () => {
    if (!postgresAvailable) return;
    const [conversation] = await db.select().from(chatConversation).where(eq(chatConversation.questId, questId));
    expect(conversation).toBeDefined();

    const inactive: QuestWorkChatMembershipTransition = {
      producer: 'QUEST_SETTLEMENT',
      type: 'workerBecameInactive',
      commandId: 'chat-inactive-1',
      eventId: 'chat-inactive-event-1',
      questId,
      actorId: workerIds[0]!,
      occurredAt: '2030-01-01T11:00:00.000Z',
      assignmentId: assignmentIds[0]!,
      workerId: workerIds[0]!,
      assignmentStatus: 'ASSIGNMENT_INCOMPLETE',
      leftAt: '2030-01-01T11:00:00.000Z',
    };
    await db.transaction(async (transaction) => {
      await transaction.update(questAssignment)
        .set({ assignmentStatus: 'ASSIGNMENT_INCOMPLETE' })
        .where(eq(questAssignment.id, assignmentIds[0]!));
      return writer.applyQuestTransition(transaction, inactive);
    });
    await db.transaction((transaction) => writer.applyQuestTransition(transaction, inactive));

    const terminal: QuestWorkChatMembershipTransition = {
      producer: 'QUEST_SETTLEMENT',
      type: 'questBecameReadOnly',
      commandId: 'chat-accept-1',
      eventId: 'chat-event-1',
      questId,
      actorId: hirerId,
      occurredAt: '2030-01-01T12:00:00.000Z',
      questStatus: 'QUEST_COMPLETED',
      readOnlyAt: '2030-01-01T12:00:00.000Z',
    };
    const result = await db.transaction((transaction) => writer.applyQuestTransition(transaction, terminal));
    await db.transaction((transaction) => writer.applyQuestTransition(transaction, terminal));

    const lateInactive: QuestWorkChatMembershipTransition = {
      ...inactive,
      commandId: 'chat-inactive-late',
      eventId: 'chat-inactive-event-late',
      assignmentId: assignmentIds[1]!,
      workerId: workerIds[1]!,
      occurredAt: '2030-01-01T13:00:00.000Z',
      leftAt: '2030-01-01T13:00:00.000Z',
    };
    await expect(db.transaction(async (transaction) => {
      await transaction.update(questAssignment)
        .set({ assignmentStatus: 'ASSIGNMENT_INCOMPLETE' })
        .where(eq(questAssignment.id, assignmentIds[1]!));
      return writer.applyQuestTransition(transaction, lateInactive);
    })).rejects.toThrow('read-only');

    const [updatedConversation] = await db.select().from(chatConversation).where(eq(chatConversation.questId, questId));
    const messages = await db.select().from(chatMessage).where(eq(chatMessage.conversationId, conversation!.id));
    const [departed] = await db.select().from(chatMembership).where(and(
      eq(chatMembership.conversationId, conversation!.id),
      eq(chatMembership.assignmentId, assignmentIds[0]!),
    ));
    const [stillCurrent] = await db.select().from(chatMembership).where(and(
      eq(chatMembership.conversationId, conversation!.id),
      eq(chatMembership.assignmentId, assignmentIds[1]!),
    ));
    expect(result.outcome).toBe('APPLIED');
    expect(updatedConversation?.readOnlyAt?.toISOString()).toBe('2030-01-01T12:00:00.000Z');
    expect(updatedConversation?.questStatus).toBe('QUEST_COMPLETED');
    expect(departed?.leftAt?.toISOString()).toBe('2030-01-01T11:00:00.000Z');
    expect(stillCurrent?.leftAt).toBeNull();
    expect(messages).toHaveLength(5);
    await expect(db.delete(quest).where(eq(quest.id, questId)).then(() => undefined)).rejects.toThrow();
    expect(await db.select({ id: chatConversation.id }).from(chatConversation).where(eq(chatConversation.questId, questId))).toHaveLength(1);
  });
});
