import { createApp } from '@/app';
import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';
import { quest, questAssignment } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import {
  chatConversation,
  chatAttachment,
  chatMembership,
  chatMessage,
  chatMessageAttachment,
  chatReadCursor,
  chatTransitionCommand,
} from '@/database/schema/work-chat.schema';
import { auth } from '@/modules/auth';
import { createWorkChatMembershipWriter } from '@/modules/work-chat';

import { randomUUID } from 'node:crypto';

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

const hirerId = randomUUID();
const workerId = randomUUID();
const otherMemberId = randomUUID();
const tagId = randomUUID();
const fixtureQuestIds: string[] = [];
const fixtureFileIds: string[] = [];
let postgresAvailable = false;
let workChatApp: ReturnType<typeof createApp>;

const authenticate = () => spyOn(auth.api, 'getSession').mockImplementation((async (
  { headers }: { headers: Headers },
) => {
  const memberId = headers.get('x-member-id') ?? hirerId;
  return { user: { id: memberId }, session: { userId: memberId } } as never;
}) as never);

const requestJson = (
  method: string,
  path: string,
  body: Record<string, unknown>,
  memberId?: string,
) => workChatApp.handle(new Request(`http://localhost${path}`, {
  method,
  headers: {
    'content-type': 'application/json',
    ...(memberId ? { 'x-member-id': memberId } : {}),
  },
  body: JSON.stringify(body),
}));

const createWorkConversation = async (): Promise<{
  questId: string;
  assignmentId: string;
  conversationId: string;
}> => {
  const questId = randomUUID();
  const assignmentId = randomUUID();
  fixtureQuestIds.push(questId);

  await db.insert(quest).values({
    id: questId,
    hirerId,
    title: 'Work Chat route test',
    condition: 'Complete the route test',
    mode: 'NO_CANDIDATE',
    participation: 'SOLO',
    questStatus: 'QUEST_OPEN',
    rewardSatang: 500,
    tagId,
    headcount: 1,
    startTime: new Date('2030-01-01T10:00:00.000Z'),
  });
  await db.insert(questAssignment).values({
    id: assignmentId,
    questId,
    workerId,
    assignmentStatus: 'ASSIGNMENT_ACTIVE',
    createdAt: new Date('2030-01-01T10:00:00.000Z'),
  });

  const result = await db.transaction((transaction) => createWorkChatMembershipWriter().applyQuestTransition(transaction, {
    producer: 'QUEST_DIRECT_JOIN',
    type: 'workersAccepted',
    commandId: `route-command-${questId}`,
    eventId: `route-event-${questId}`,
    questId,
    actorId: workerId,
    hirerId,
    occurredAt: '2030-01-01T10:00:00.000Z',
    workers: [{
      workerId,
      assignmentId,
      joinedAt: '2030-01-01T10:00:00.000Z',
    }],
  }));

  return { questId, assignmentId, conversationId: result.conversationId! };
};

const createValidatedAttachments = async (conversationId: string, memberId: string, count: number) => {
  const [membership] = await db
    .select({ id: chatMembership.id })
    .from(chatMembership)
    .where(and(
      eq(chatMembership.conversationId, conversationId),
      eq(chatMembership.memberId, memberId),
      isNull(chatMembership.leftAt),
    ))
    .limit(1);
  if (!membership) throw new Error('Fixture Chat Membership not found');

  const attachments = Array.from({ length: count }, (_, index) => {
    const attachmentId = randomUUID();
    const fileId = randomUUID();
    fixtureFileIds.push(fileId);
    return {
      attachmentId,
      fileId,
      index,
    };
  });
  await db.insert(file).values(attachments.map(({ fileId }) => ({
    id: fileId,
    bucket: 'test-work-chat',
    objectKey: `work-chat/${fileId}`,
    contentType: 'image/png',
    sizeBytes: 3,
    uploadedByUserId: memberId,
  })));
  await db.insert(chatAttachment).values(attachments.map(({ attachmentId, fileId, index }) => ({
    id: attachmentId,
    conversationId,
    uploadedByMemberId: membership.id,
    fileId,
    status: 'VALIDATED' as const,
    originalFilename: `attachment-${index}.png`,
    mimeType: 'image/png',
    sizeBytes: 3,
    validatedAt: new Date(),
  })));
  return attachments.map(({ attachmentId }) => attachmentId);
};

const cleanFixtures = async (): Promise<void> => {
  if (!postgresAvailable || fixtureQuestIds.length === 0) return;

  await db.delete(chatTransitionCommand).where(inArray(chatTransitionCommand.questId, fixtureQuestIds));
  const conversations = await db.select({ id: chatConversation.id })
    .from(chatConversation)
    .where(inArray(chatConversation.questId, fixtureQuestIds));
  const conversationIds = conversations.map(({ id }) => id);
  if (conversationIds.length > 0) {
    await db.delete(chatReadCursor).where(inArray(chatReadCursor.conversationId, conversationIds));
    const messages = await db.select({ id: chatMessage.id })
      .from(chatMessage)
      .where(inArray(chatMessage.conversationId, conversationIds));
    const messageIds = messages.map(({ id }) => id);
    if (messageIds.length > 0) {
      await db.delete(chatMessageAttachment).where(inArray(chatMessageAttachment.messageId, messageIds));
    }
    await db.delete(chatMessage).where(inArray(chatMessage.conversationId, conversationIds));
    await db.delete(chatAttachment).where(inArray(chatAttachment.conversationId, conversationIds));
    await db.delete(chatMembership).where(inArray(chatMembership.conversationId, conversationIds));
    await db.delete(chatConversation).where(inArray(chatConversation.id, conversationIds));
  }
  if (fixtureFileIds.length > 0) {
    await db.delete(file).where(inArray(file.id, fixtureFileIds));
  }
  await db.delete(questAssignment).where(inArray(questAssignment.questId, fixtureQuestIds));
  await db.delete(quest).where(inArray(quest.id, fixtureQuestIds));
  fixtureQuestIds.length = 0;
  fixtureFileIds.length = 0;
};

beforeAll(async () => {
  try {
    await sql`select 1`;
    postgresAvailable = true;
  } catch {
    return;
  }

  await db.insert(authUser).values([
    { id: hirerId, email: `${hirerId}@ku.th`, firstName: 'Route', lastName: 'Hirer' },
    { id: workerId, email: `${workerId}@ku.th`, firstName: 'Route', lastName: 'Worker' },
    { id: otherMemberId, email: `${otherMemberId}@ku.th`, firstName: 'Other', lastName: 'Member' },
  ]);
  await db.insert(tag).values({ id: tagId, name: `Work Chat route ${tagId}` });
});

beforeEach(() => {
  workChatApp = createApp();
});

afterEach(async () => {
  mock.restore();
  await cleanFixtures();
});

afterAll(async () => {
  if (!postgresAvailable) return;
  await db.delete(tag).where(eq(tag.id, tagId));
  await db.delete(authUser).where(inArray(authUser.id, [hirerId, workerId, otherMemberId]));
});

describe('Work Chat Member API', () => {
  it('requires Member authentication for every documented route', async () => {
    const responses = await Promise.all([
      workChatApp.handle(new Request('http://localhost/api/v1/chat/conversations')),
      workChatApp.handle(new Request(`http://localhost/api/v1/chat/conversations/${randomUUID()}/messages`)),
      workChatApp.handle(new Request(`http://localhost/api/v1/chat/conversations/${randomUUID()}/participants`)),
      requestJson('POST', `/api/v1/chat/conversations/${randomUUID()}/read`, { messageId: randomUUID() }),
      requestJson('POST', `/api/v1/chat/conversations/${randomUUID()}/messages`, {
        clientMessageId: 'unauthorized-message',
        text: 'hello',
      }),
    ]);

    const bodies = await Promise.all(responses.map((response) => response.json()));
    for (const [index, body] of bodies.entries()) {
      expect(responses[index]?.status).toBe(401);
      expect(body.error.code).toBe('UNAUTHORIZED');
    }
  });

  it('exposes the documented Work Conversation operations with Member security', async () => {
    const response = await workChatApp.handle(new Request('http://localhost/openapi/json'));
    const document = (await response.json()) as {
      paths: Record<string, Record<string, {
        operationId?: string;
        security?: unknown;
        responses?: Record<string, unknown>;
      }>>;
    };

    const operations = [
      ['/api/v1/chat/conversations', 'get', 'listWorkConversations'],
      ['/api/v1/chat/conversations/{conversationId}/participants', 'get', 'listWorkConversationParticipants'],
      ['/api/v1/chat/conversations/{conversationId}/messages', 'get', 'listWorkConversationMessages'],
      ['/api/v1/chat/conversations/{conversationId}/messages', 'post', 'sendWorkConversationMessage'],
      ['/api/v1/chat/conversations/{conversationId}/read', 'post', 'advanceWorkConversationReadCursor'],
    ] as const;

    for (const [path, method, operationId] of operations) {
      expect(document.paths[path]?.[method]?.operationId).toBe(operationId);
      expect(document.paths[path]?.[method]?.security).toEqual([{ betterAuthSession: [] }]);
    }
    expect(document.paths['/api/v1/chat/conversations/{conversationId}/messages']?.post?.responses?.['429']).toBeDefined();
  });

  it('allows the accepted Hirer and Worker to use the Conversation and denies a non-member', async () => {
    if (!postgresAvailable) return;
    authenticate();
    const { questId, conversationId } = await createWorkConversation();

    const workerList = await workChatApp.handle(new Request(
      `http://localhost/api/v1/chat/conversations?limit=20`,
      { headers: { 'x-member-id': workerId } },
    ));
    expect(workerList.status).toBe(200);
    const workerListBody = await workerList.json() as { data: { items: Array<{ id: string; quest: { id: string } }> } };
    expect(workerListBody.data.items).toHaveLength(1);
    expect(workerListBody.data.items[0]?.id).toBe(conversationId);
    expect(workerListBody.data.items[0]?.quest.id).toBe(questId);

    const history = await workChatApp.handle(new Request(
      `http://localhost/api/v1/chat/conversations/${conversationId}/messages`,
      { headers: { 'x-member-id': workerId } },
    ));
    expect(history.status).toBe(200);
    const historyBody = await history.json() as { data: { items: Array<{ kind: string }> } };
    expect(historyBody.data.items[0]?.kind).toBe('SYSTEM');

    const participants = await workChatApp.handle(new Request(
      `http://localhost/api/v1/chat/conversations/${conversationId}/participants`,
      { headers: { 'x-member-id': workerId } },
    ));
    expect(participants.status).toBe(200);
    const participantsBody = await participants.json() as {
      data: { participants: Array<{ id: string; role: string; displayName: string }> };
    };
    expect(participantsBody.data.participants).toEqual([
      { id: hirerId, role: 'HIRER', displayName: 'Route Hirer' },
      { id: workerId, role: 'WORKER', displayName: 'Route Worker' },
    ]);

    const sent = await requestJson('POST', `/api/v1/chat/conversations/${conversationId}/messages`, {
      clientMessageId: 'worker-message-1',
      text: 'Worker message',
    }, workerId);
    expect(sent.status).toBe(200);
    const sentBody = await sent.json() as { data: { message: { id: string; sequence: number } } };

    const replay = await requestJson('POST', `/api/v1/chat/conversations/${conversationId}/messages`, {
      clientMessageId: 'worker-message-1',
      text: 'Worker message',
    }, workerId);
    expect(replay.status).toBe(200);
    const replayBody = await replay.json() as { data: { message: { id: string; sequence: number } } };
    expect(replayBody.data.message).toEqual(sentBody.data.message);

    const reused = await requestJson('POST', `/api/v1/chat/conversations/${conversationId}/messages`, {
      clientMessageId: 'worker-message-1',
      text: 'Different message',
    }, workerId);
    expect(reused.status).toBe(409);
    expect((await reused.json()).error.code).toBe('CLIENT_MESSAGE_ID_REUSED');

    const read = await requestJson('POST', `/api/v1/chat/conversations/${conversationId}/read`, {
      messageId: sentBody.data.message.id,
    }, workerId);
    expect(read.status).toBe(200);
    expect((await read.json()).data.messageId).toBe(sentBody.data.message.id);

    const hirerSent = await requestJson('POST', `/api/v1/chat/conversations/${conversationId}/messages`, {
      clientMessageId: 'hirer-message-1',
      text: 'Hirer message',
    }, hirerId);
    expect(hirerSent.status).toBe(200);

    const attachmentIds = await createValidatedAttachments(conversationId, workerId, 2);
    const requestedAttachmentIds = [attachmentIds[1]!, attachmentIds[0]!];
    const attachmentSent = await requestJson('POST', `/api/v1/chat/conversations/${conversationId}/messages`, {
      clientMessageId: 'worker-message-with-attachments',
      text: 'Worker files',
      attachmentIds: requestedAttachmentIds,
    }, workerId);
    expect(attachmentSent.status).toBe(200);
    const attachmentSentBody = await attachmentSent.json() as {
      data: { message: { id: string; attachments: Array<{ id: string }> } };
    };
    expect(attachmentSentBody.data.message.attachments.map(({ id }) => id)).toEqual(requestedAttachmentIds);

    const attachmentReplay = await requestJson('POST', `/api/v1/chat/conversations/${conversationId}/messages`, {
      clientMessageId: 'worker-message-with-attachments',
      text: 'Worker files',
      attachmentIds: requestedAttachmentIds,
    }, workerId);
    expect(attachmentReplay.status).toBe(200);
    const attachmentReplayBody = await attachmentReplay.json() as {
      data: { message: { id: string; attachments: Array<{ id: string }> } };
    };
    expect(attachmentReplayBody.data.message.id).toBe(attachmentSentBody.data.message.id);
    expect(attachmentReplayBody.data.message.attachments.map(({ id }) => id)).toEqual(requestedAttachmentIds);

    const newestPage = await workChatApp.handle(new Request(
      `http://localhost/api/v1/chat/conversations/${conversationId}/messages?limit=1`,
      { headers: { 'x-member-id': workerId } },
    ));
    const newestPageBody = await newestPage.json() as { data: { nextCursor: string | null; hasMore: boolean } };
    expect(newestPage.status).toBe(200);
    expect(newestPageBody.data.hasMore).toBe(true);
    expect(newestPageBody.data.nextCursor).toBeString();

    const olderPage = await workChatApp.handle(new Request(
      `http://localhost/api/v1/chat/conversations/${conversationId}/messages?limit=1&before=${encodeURIComponent(newestPageBody.data.nextCursor!)}`,
      { headers: { 'x-member-id': workerId } },
    ));
    expect(olderPage.status).toBe(200);
    expect((await olderPage.json()).data.items).toHaveLength(1);

    const nonMemberHistory = await workChatApp.handle(new Request(
      `http://localhost/api/v1/chat/conversations/${conversationId}/messages`,
      { headers: { 'x-member-id': otherMemberId } },
    ));
    expect(nonMemberHistory.status).toBe(404);
    expect((await nonMemberHistory.json()).error.code).toBe('CONVERSATION_NOT_FOUND');

    const nonMemberSend = await requestJson('POST', `/api/v1/chat/conversations/${conversationId}/messages`, {
      clientMessageId: 'other-message-1',
      text: 'Should be denied',
    }, otherMemberId);
    expect(nonMemberSend.status).toBe(404);
    expect((await nonMemberSend.json()).error.code).toBe('CONVERSATION_NOT_FOUND');

    const nonMemberParticipants = await workChatApp.handle(new Request(
      `http://localhost/api/v1/chat/conversations/${conversationId}/participants`,
      { headers: { 'x-member-id': otherMemberId } },
    ));
    expect(nonMemberParticipants.status).toBe(404);
    expect((await nonMemberParticipants.json()).error.code).toBe('CONVERSATION_NOT_FOUND');

    await db.update(chatConversation).set({
      questStatus: 'QUEST_COMPLETED',
      readOnlyAt: new Date('2030-01-01T11:00:00.000Z'),
      latestTerminalAt: new Date('2030-01-01T11:00:00.000Z'),
    }).where(eq(chatConversation.id, conversationId));

    const terminalSend = await requestJson('POST', `/api/v1/chat/conversations/${conversationId}/messages`, {
      clientMessageId: 'worker-message-after-terminal',
      text: 'Should be read-only',
    }, workerId);
    expect(terminalSend.status).toBe(409);
    expect((await terminalSend.json()).error.code).toBe('CONVERSATION_READ_ONLY');

    const terminalHistory = await workChatApp.handle(new Request(
      `http://localhost/api/v1/chat/conversations/${conversationId}/messages`,
      { headers: { 'x-member-id': workerId } },
    ));
    expect(terminalHistory.status).toBe(200);
  });

  it('validates message content and mutually exclusive history cursors', async () => {
    if (!postgresAvailable) return;
    authenticate();
    const { conversationId } = await createWorkConversation();

    const emptyMessage = await requestJson('POST', `/api/v1/chat/conversations/${conversationId}/messages`, {
      clientMessageId: 'empty-message',
    }, hirerId);
    expect(emptyMessage.status).toBe(400);
    expect((await emptyMessage.json()).error.code).toBe('MESSAGE_CONTENT_REQUIRED');

    const invalidHistory = await workChatApp.handle(new Request(
      `http://localhost/api/v1/chat/conversations/${randomUUID()}/messages?before=one&after=two`,
      { headers: { 'x-member-id': hirerId } },
    ));
    expect(invalidHistory.status).toBe(400);
    expect((await invalidHistory.json()).error.code).toBe('VALIDATION');
  });

  it('rejects a send when the Member departs before the locked Conversation is used', async () => {
    if (!postgresAvailable) return;
    authenticate();
    const { conversationId } = await createWorkConversation();
    let releaseDeparture!: () => void;
    let departure!: Promise<void>;
    const departureReady = new Promise<void>((resolve) => {
      departure = db.transaction(async (transaction) => {
        await transaction
          .select({ id: chatConversation.id })
          .from(chatConversation)
          .where(eq(chatConversation.id, conversationId))
          .for('update');
        resolve();
        await new Promise<void>((release) => {
          releaseDeparture = release;
        });
        await transaction
          .update(chatMembership)
          .set({ leftAt: new Date('2030-01-01T11:00:00.000Z') })
          .where(and(
            eq(chatMembership.conversationId, conversationId),
            eq(chatMembership.memberId, workerId),
            isNull(chatMembership.leftAt),
          ));
      });
    });
    await departureReady;

    const sendPromise = requestJson('POST', `/api/v1/chat/conversations/${conversationId}/messages`, {
      clientMessageId: 'worker-message-after-departure',
      text: 'Should not be sent',
    }, workerId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseDeparture();
    const response = await sendPromise;
    await departure;
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe('CONVERSATION_NOT_FOUND');
  });

  it('enforces the per-Minute Message and Attachment limits', async () => {
    if (!postgresAvailable) return;
    authenticate();
    const messageFixture = await createWorkConversation();
    for (let index = 0; index < 30; index += 1) {
      const response = await requestJson('POST', `/api/v1/chat/conversations/${messageFixture.conversationId}/messages`, {
        clientMessageId: `rate-message-${index}`,
        text: 'Rate test',
      }, workerId);
      expect(response.status).toBe(200);
    }
    const messageLimited = await requestJson('POST', `/api/v1/chat/conversations/${messageFixture.conversationId}/messages`, {
      clientMessageId: 'rate-message-30',
      text: 'Rate test',
    }, workerId);
    expect(messageLimited.status).toBe(429);
    expect((await messageLimited.json()).error.code).toBe('RATE_LIMITED');

    const attachmentFixture = await createWorkConversation();
    const attachmentIds = await createValidatedAttachments(attachmentFixture.conversationId, workerId, 11);
    const firstAttachments = await requestJson('POST', `/api/v1/chat/conversations/${attachmentFixture.conversationId}/messages`, {
      clientMessageId: 'rate-attachments-1',
      attachmentIds: attachmentIds.slice(0, 5),
    }, workerId);
    expect(firstAttachments.status).toBe(200);
    const secondAttachments = await requestJson('POST', `/api/v1/chat/conversations/${attachmentFixture.conversationId}/messages`, {
      clientMessageId: 'rate-attachments-2',
      attachmentIds: attachmentIds.slice(5, 10),
    }, workerId);
    expect(secondAttachments.status).toBe(200);
    const attachmentLimited = await requestJson('POST', `/api/v1/chat/conversations/${attachmentFixture.conversationId}/messages`, {
      clientMessageId: 'rate-attachments-3',
      attachmentIds: attachmentIds.slice(10),
    }, workerId);
    expect(attachmentLimited.status).toBe(429);
    expect((await attachmentLimited.json()).error.code).toBe('RATE_LIMITED');
  });
});
