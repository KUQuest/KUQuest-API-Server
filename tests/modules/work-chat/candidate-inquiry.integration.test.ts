import { createApp } from '@/app';
import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';
import { quest, questAssignment } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import {
  chatAttachment,
  chatConversation,
  chatMembership,
  chatMessage,
  chatMessageAttachment,
  chatReadCursor,
  chatTransitionCommand,
} from '@/database/schema/work-chat.schema';
import { auth } from '@/modules/auth';
import { createWorkChatMembershipWriter, workChatStorage } from '@/modules/work-chat';

import { randomUUID } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

const hirerId = randomUUID();
const workerId = randomUUID();
const otherWorkerId = randomUUID();
const outsiderId = randomUUID();
const tagId = randomUUID();
const fixtureQuestIds: string[] = [];
const fixtureFileIds: string[] = [];
let postgresAvailable = false;
let candidateInquiryApp: { handle: (request: Request) => Promise<Response> };

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
  memberId: string,
) => candidateInquiryApp.handle(new Request(`http://localhost${path}`, {
  method,
  headers: {
    'content-type': 'application/json',
    'x-member-id': memberId,
  },
  body: JSON.stringify(body),
}));

const createOpenQuest = async () => {
  const questId = randomUUID();
  fixtureQuestIds.push(questId);
  await db.insert(quest).values({
    id: questId,
    hirerId,
    title: 'Candidate Inquiry test',
    condition: 'Ask about the Quest',
    mode: 'CANDIDATE',
    participation: 'SOLO',
    questStatus: 'QUEST_OPEN',
    rewardSatang: 500,
    tagId,
    headcount: 1,
    startTime: new Date('2030-01-01T10:00:00.000Z'),
  });
  return questId;
};

const createPreparedAttachments = async (
  conversationId: string,
  memberId: string,
  count: number,
  discarded = false,
) => {
  const [membership] = await db
    .select({ id: chatMembership.id })
    .from(chatMembership)
    .where(and(
      eq(chatMembership.conversationId, conversationId),
      eq(chatMembership.memberId, memberId),
    ));
  if (!membership) throw new Error('Candidate Inquiry Membership fixture not found');

  const createdAt = new Date();
  const files = await db.insert(file).values(Array.from({ length: count }, (_, index) => ({
    bucket: 'test-candidate-inquiry',
    objectKey: `candidate-inquiry/${conversationId}/prepared-${randomUUID()}-${index}.png`,
    contentType: 'image/png',
    sizeBytes: 3,
    uploadedByUserId: memberId,
    createdAt,
    ...(discarded ? { deletedAt: createdAt } : {}),
  }))).returning({ id: file.id });
  fixtureFileIds.push(...files.map(({ id }) => id));

  return db.insert(chatAttachment).values(files.map(({ id }, index) => ({
    conversationId,
    uploadedByMemberId: membership.id,
    fileId: id,
    status: discarded ? 'EXPIRED' as const : 'VALIDATED' as const,
    originalFilename: `prepared-${index}.png`,
    mimeType: 'image/png',
    sizeBytes: 3,
    validatedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
    ...(discarded ? { deletedAt: createdAt, expiresAt: createdAt } : {}),
  }))).returning({ id: chatAttachment.id });
};

const cleanFixtures = async (): Promise<void> => {
  if (!postgresAvailable || fixtureQuestIds.length === 0) return;

  await db.transaction(async (transaction) => {
    await transaction.delete(chatTransitionCommand).where(inArray(chatTransitionCommand.questId, fixtureQuestIds));
    const conversations = await transaction.select({ id: chatConversation.id })
      .from(chatConversation)
      .where(inArray(chatConversation.questId, fixtureQuestIds));
    const conversationIds = conversations.map(({ id }) => id);
    if (conversationIds.length > 0) {
      await transaction.delete(chatReadCursor).where(inArray(chatReadCursor.conversationId, conversationIds));
      const messages = await transaction.select({ id: chatMessage.id })
        .from(chatMessage)
        .where(inArray(chatMessage.conversationId, conversationIds));
      const messageIds = messages.map(({ id }) => id);
      if (messageIds.length > 0) {
        await transaction.delete(chatMessageAttachment).where(inArray(chatMessageAttachment.messageId, messageIds));
      }
      await transaction.delete(chatMessage).where(inArray(chatMessage.conversationId, conversationIds));
      await transaction.delete(chatAttachment).where(inArray(chatAttachment.conversationId, conversationIds));
      await transaction.delete(chatMembership).where(inArray(chatMembership.conversationId, conversationIds));
      await transaction.delete(chatConversation).where(inArray(chatConversation.id, conversationIds));
    }
    if (fixtureFileIds.length > 0) {
      await transaction.delete(file).where(inArray(file.id, fixtureFileIds));
    }
    await transaction.delete(questAssignment).where(inArray(questAssignment.questId, fixtureQuestIds));
    await transaction.delete(quest).where(inArray(quest.id, fixtureQuestIds));
  });
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
    { id: hirerId, email: `${hirerId}@ku.th`, firstName: 'Inquiry', lastName: 'Hirer' },
    { id: workerId, email: `${workerId}@ku.th`, firstName: 'Inquiry', lastName: 'Worker' },
    { id: otherWorkerId, email: `${otherWorkerId}@ku.th`, firstName: 'Other', lastName: 'Worker' },
    { id: outsiderId, email: `${outsiderId}@ku.th`, firstName: 'Inquiry', lastName: 'Outsider' },
  ]);
  await db.insert(tag).values({
    id: tagId,
    name: `Candidate Inquiry ${tagId}`,
  });
});

beforeEach(() => {
  candidateInquiryApp = createApp();
});

afterEach(async () => {
  mock.restore();
  await cleanFixtures();
});

afterAll(async () => {
  if (!postgresAvailable) return;
  await db.delete(tag).where(eq(tag.id, tagId));
  await db.delete(authUser).where(inArray(authUser.id, [hirerId, workerId, otherWorkerId, outsiderId]));
});

describe('Candidate Inquiry Conversation API', () => {
  it('publishes the Candidate Inquiry REST operations with Member security', async () => {
    const response = await candidateInquiryApp.handle(new Request('http://localhost/openapi/json'));
    const document = await response.json() as {
      paths: Record<string, Record<string, { operationId?: string; security?: unknown }>>;
    };
    const operations = [
      ['/api/v1/chat/candidate-inquiries', 'post', 'openCandidateInquiry'],
      ['/api/v1/chat/candidate-inquiries', 'get', 'listCandidateInquiries'],
      ['/api/v1/chat/candidate-inquiries/{conversationId}', 'get', 'getCandidateInquiry'],
      ['/api/v1/chat/candidate-inquiries/{conversationId}/participants', 'get', 'listCandidateInquiryParticipants'],
      ['/api/v1/chat/candidate-inquiries/{conversationId}/attachments', 'post', 'uploadCandidateInquiryAttachment'],
      ['/api/v1/chat/candidate-inquiries/{conversationId}/attachments/{attachmentId}/link', 'get', 'getCandidateInquiryAttachmentLink'],
      ['/api/v1/chat/candidate-inquiries/{conversationId}/attachments/{attachmentId}', 'delete', 'discardCandidateInquiryAttachment'],
      ['/api/v1/chat/candidate-inquiries/{conversationId}/messages', 'get', 'listCandidateInquiryMessages'],
      ['/api/v1/chat/candidate-inquiries/{conversationId}/messages', 'post', 'sendCandidateInquiryMessage'],
      ['/api/v1/chat/candidate-inquiries/{conversationId}/read', 'post', 'advanceCandidateInquiryReadCursor'],
    ] as const;
    for (const [path, method, operationId] of operations) {
      expect(document.paths[path]?.[method]?.operationId).toBe(operationId);
      expect(document.paths[path]?.[method]?.security).toEqual([{ betterAuthSession: [] }]);
    }
  });

  it('opens a private inquiry, supports both participants, and keeps it out of Work Chat', async () => {
    if (!postgresAvailable) return;
    authenticate();
    const questId = await createOpenQuest();

    const opened = await requestJson('POST', '/api/v1/chat/candidate-inquiries', { questId }, workerId);
    expect(opened.status).toBe(200);
    const openedBody = await opened.json() as {
      data: {
        inquiry: {
          id: string;
          type: string;
          state: string;
          participants: Array<{ id: string; role: string; displayName: string }>;
        };
      };
    };
    const conversationId = openedBody.data.inquiry.id;
    expect(openedBody.data.inquiry.type).toBe('CONVERSATION_CANDIDATE_INQUIRY');
    expect(openedBody.data.inquiry.state).toBe('INQUIRY_OPEN');
    expect(openedBody.data.inquiry.participants).toEqual([
      { id: hirerId, role: 'HIRER', displayName: 'Inquiry Hirer' },
      { id: workerId, role: 'PROSPECTIVE_WORKER', displayName: 'Inquiry Worker' },
    ]);

    const replay = await requestJson('POST', '/api/v1/chat/candidate-inquiries', { questId }, workerId);
    expect(replay.status).toBe(200);
    expect((await replay.json()).data.inquiry.id).toBe(conversationId);

    const workerMessage = await requestJson(
      'POST',
      `/api/v1/chat/candidate-inquiries/${conversationId}/messages`,
      { clientMessageId: 'inquiry-worker-1', text: 'Can I ask a question?' },
      workerId,
    );
    expect(workerMessage.status).toBe(200);
    const workerMessageBody = await workerMessage.json() as { data: { message: { id: string; kind: string } } };
    expect(workerMessageBody.data.message.kind).toBe('USER');

    const hirerHistory = await candidateInquiryApp.handle(new Request(
      `http://localhost/api/v1/chat/candidate-inquiries/${conversationId}/messages`,
      { headers: { 'x-member-id': hirerId } },
    ));
    expect(hirerHistory.status).toBe(200);
    const historyBody = await hirerHistory.json() as { data: { items: Array<{ id: string; systemType: string | null }> } };
    expect(historyBody.data.items).toHaveLength(1);
    expect(historyBody.data.items[0]).toMatchObject({ id: workerMessageBody.data.message.id, systemType: null });

    const workList = await candidateInquiryApp.handle(new Request(
      'http://localhost/api/v1/chat/conversations',
      { headers: { 'x-member-id': workerId } },
    ));
    expect(workList.status).toBe(200);
    expect((await workList.json()).data.items).toHaveLength(0);

    const workHistory = await candidateInquiryApp.handle(new Request(
      `http://localhost/api/v1/chat/conversations/${conversationId}/messages`,
      { headers: { 'x-member-id': workerId } },
    ));
    expect(workHistory.status).toBe(404);
    expect((await workHistory.json()).error.code).toBe('CONVERSATION_NOT_FOUND');

    const outsider = await candidateInquiryApp.handle(new Request(
      `http://localhost/api/v1/chat/candidate-inquiries/${conversationId}`,
      { headers: { 'x-member-id': outsiderId } },
    ));
    expect(outsider.status).toBe(404);
    expect((await outsider.json()).error.code).toBe('CONVERSATION_NOT_FOUND');
  });

  it('supports attachment-only Messages, links, and private Read Cursors', async () => {
    if (!postgresAvailable) return;
    authenticate();
    const questId = await createOpenQuest();
    const opened = await requestJson('POST', '/api/v1/chat/candidate-inquiries', { questId }, workerId);
    const conversationId = (await opened.json()).data.inquiry.id as string;
    const storedObject = {
      bucket: 'test-candidate-inquiry',
      objectKey: `candidate-inquiry/${conversationId}/attachment.png`,
      contentType: 'image/png' as const,
      sizeBytes: 3,
      fileName: 'attachment.png',
    };
    spyOn(workChatStorage, 'upload').mockResolvedValue(storedObject);
    spyOn(workChatStorage, 'remove').mockResolvedValue(undefined);
    spyOn(workChatStorage, 'linkFor').mockReturnValue({
      url: 'https://storage.test/candidate-inquiry-link',
      expiresAt: new Date('2030-01-01T11:15:00.000Z'),
    });
    const form = new FormData();
    form.set('file', new File([new Uint8Array([1, 2, 3])], 'attachment.png', { type: 'image/png' }));
    const uploaded = await candidateInquiryApp.handle(new Request(
      `http://localhost/api/v1/chat/candidate-inquiries/${conversationId}/attachments`,
      { method: 'POST', headers: { 'x-member-id': workerId }, body: form },
    ));
    expect(uploaded.status).toBe(200);
    const uploadedBody = await uploaded.json() as { data: { attachment: { id: string } } };
    const [storedFile] = await db.select({ id: file.id }).from(file).where(eq(file.objectKey, storedObject.objectKey));
    if (storedFile) fixtureFileIds.push(storedFile.id);

    const sent = await requestJson(
      'POST',
      `/api/v1/chat/candidate-inquiries/${conversationId}/messages`,
      { clientMessageId: 'inquiry-attachment-only', attachmentIds: [uploadedBody.data.attachment.id] },
      workerId,
    );
    expect(sent.status).toBe(200);
    const sentBody = await sent.json() as { data: { message: { id: string; attachments: Array<{ id: string }> } } };
    expect(sentBody.data.message.attachments.map(({ id }) => id)).toEqual([uploadedBody.data.attachment.id]);

    const link = await candidateInquiryApp.handle(new Request(
      `http://localhost/api/v1/chat/candidate-inquiries/${conversationId}/attachments/${uploadedBody.data.attachment.id}/link`,
      { headers: { 'x-member-id': hirerId } },
    ));
    expect(link.status).toBe(200);
    expect((await link.json()).data.url).toBe('https://storage.test/candidate-inquiry-link');

    const read = await requestJson(
      'POST',
      `/api/v1/chat/candidate-inquiries/${conversationId}/read`,
      { messageId: sentBody.data.message.id },
      hirerId,
    );
    expect(read.status).toBe(200);
    expect((await read.json()).data.messageId).toBe(sentBody.data.message.id);
  });

  it('allows a Candidate Inquiry Message to contain more than five Attachments', async () => {
    if (!postgresAvailable) return;
    authenticate();
    const questId = await createOpenQuest();
    const opened = await requestJson('POST', '/api/v1/chat/candidate-inquiries', { questId }, workerId);
    const conversationId = (await opened.json()).data.inquiry.id as string;
    const attachments = await createPreparedAttachments(conversationId, workerId, 6);

    const sent = await requestJson(
      'POST',
      `/api/v1/chat/candidate-inquiries/${conversationId}/messages`,
      {
        clientMessageId: 'inquiry-six-attachments',
        attachmentIds: attachments.map(({ id }) => id),
      },
      workerId,
    );

    expect(sent.status).toBe(200);
    expect((await sent.json()).data.message.attachments).toHaveLength(6);
  });

  it('keeps discarded Candidate Inquiry Attachments in the one-minute rate limit', async () => {
    if (!postgresAvailable) return;
    authenticate();
    const questId = await createOpenQuest();
    const opened = await requestJson('POST', '/api/v1/chat/candidate-inquiries', { questId }, workerId);
    const conversationId = (await opened.json()).data.inquiry.id as string;
    await createPreparedAttachments(conversationId, workerId, 10, true);

    const storedObject = {
      bucket: 'test-candidate-inquiry',
      objectKey: `candidate-inquiry/${conversationId}/rate-limit.png`,
      contentType: 'image/png' as const,
      sizeBytes: 3,
      fileName: 'rate-limit.png',
    };
    spyOn(workChatStorage, 'upload').mockResolvedValue(storedObject);
    spyOn(workChatStorage, 'remove').mockResolvedValue(undefined);
    const form = new FormData();
    form.set('file', new File([new Uint8Array([1, 2, 3])], 'rate-limit.png', { type: 'image/png' }));

    const upload = await candidateInquiryApp.handle(new Request(
      `http://localhost/api/v1/chat/candidate-inquiries/${conversationId}/attachments`,
      { method: 'POST', headers: { 'x-member-id': workerId }, body: form },
    ));
    const [storedFile] = await db
      .select({ id: file.id })
      .from(file)
      .where(eq(file.objectKey, storedObject.objectKey));
    if (storedFile) fixtureFileIds.push(storedFile.id);

    expect(upload.status).toBe(429);
  });

  it('enforces the Attachment-only Message rule at the database boundary', async () => {
    if (!postgresAvailable) return;
    authenticate();
    const questId = await createOpenQuest();
    const opened = await requestJson('POST', '/api/v1/chat/candidate-inquiries', { questId }, workerId);
    const conversationId = (await opened.json()).data.inquiry.id as string;
    const [membership] = await db.select({ id: chatMembership.id })
      .from(chatMembership)
      .where(eq(chatMembership.conversationId, conversationId));
    if (!membership) throw new Error('Candidate Inquiry Membership fixture not found');

    await expect(db.insert(chatMessage).values({
      conversationId,
      sequence: 1,
      kind: 'USER',
      senderMembershipId: membership.id,
      clientMessageId: 'invalid-empty-direct-message',
      contentText: null,
    }).execute()).rejects.toThrow();
  });

  it('closes the inquiry when the Prospective Worker receives an Assignment', async () => {
    if (!postgresAvailable) return;
    authenticate();
    const questId = await createOpenQuest();
    const opened = await requestJson('POST', '/api/v1/chat/candidate-inquiries', { questId }, workerId);
    const conversationId = (await opened.json()).data.inquiry.id as string;
    const otherOpened = await requestJson('POST', '/api/v1/chat/candidate-inquiries', { questId }, otherWorkerId);
    const otherConversationId = (await otherOpened.json()).data.inquiry.id as string;
    const assignmentId = randomUUID();

    await db.transaction(async (transaction) => {
      const now = new Date('2030-01-01T10:00:00.000Z');
      await transaction.insert(questAssignment).values({
        id: assignmentId,
        questId,
        workerId,
        assignmentStatus: 'ASSIGNMENT_ACTIVE',
        createdAt: now,
      });
      await transaction.update(quest).set({ questStatus: 'QUEST_ASSIGNED', updatedAt: now }).where(eq(quest.id, questId));
      await createWorkChatMembershipWriter().applyQuestTransition(transaction, {
        producer: 'QUEST_DIRECT_JOIN',
        type: 'workersAccepted',
        commandId: `candidate-inquiry-close-${questId}`,
        eventId: `candidate-inquiry-close-event-${questId}`,
        questId,
        actorId: workerId,
        hirerId,
        occurredAt: now.toISOString(),
        workers: [{ workerId, assignmentId, joinedAt: now.toISOString() }],
      });
    });

    const closedRead = await candidateInquiryApp.handle(new Request(
      `http://localhost/api/v1/chat/candidate-inquiries/${conversationId}`,
      { headers: { 'x-member-id': workerId } },
    ));
    expect(closedRead.status).toBe(404);
    expect((await closedRead.json()).error.code).toBe('CONVERSATION_NOT_FOUND');

    const [closed] = await db.select({ state: chatConversation.state, closedAt: chatConversation.closedAt })
      .from(chatConversation)
      .where(eq(chatConversation.id, conversationId));
    expect(closed?.state).toBe('INQUIRY_CLOSED');
    expect(closed?.closedAt).toBeDate();

    const otherClosedRead = await candidateInquiryApp.handle(new Request(
      `http://localhost/api/v1/chat/candidate-inquiries/${otherConversationId}`,
      { headers: { 'x-member-id': otherWorkerId } },
    ));
    expect(otherClosedRead.status).toBe(404);

    const workList = await candidateInquiryApp.handle(new Request(
      'http://localhost/api/v1/chat/conversations',
      { headers: { 'x-member-id': workerId } },
    ));
    expect(workList.status).toBe(200);
    expect((await workList.json()).data.items).toHaveLength(1);
  });

  it('closes all open inquiries when the Quest is cancelled before assignment', async () => {
    if (!postgresAvailable) return;
    authenticate();
    const questId = await createOpenQuest();
    const opened = await requestJson('POST', '/api/v1/chat/candidate-inquiries', { questId }, otherWorkerId);
    const conversationId = (await opened.json()).data.inquiry.id as string;

    await db.transaction(async (transaction) => {
      const now = new Date('2030-01-01T10:00:00.000Z');
      await transaction.update(quest).set({ questStatus: 'QUEST_CANCELLED', cancelledAt: now, updatedAt: now }).where(eq(quest.id, questId));
      await createWorkChatMembershipWriter().applyQuestTransition(transaction, {
        producer: 'QUEST_SETTLEMENT',
        type: 'questBecameReadOnly',
        commandId: `candidate-inquiry-cancel-${questId}`,
        eventId: `candidate-inquiry-cancel-event-${questId}`,
        questId,
        actorId: hirerId,
        occurredAt: now.toISOString(),
        questStatus: 'QUEST_CANCELLED',
        readOnlyAt: now.toISOString(),
      });
    });

    const listed = await candidateInquiryApp.handle(new Request(
      'http://localhost/api/v1/chat/candidate-inquiries',
      { headers: { 'x-member-id': otherWorkerId } },
    ));
    expect(listed.status).toBe(200);
    expect((await listed.json()).data.items).toHaveLength(0);
    const [closed] = await db.select({ state: chatConversation.state }).from(chatConversation)
      .where(eq(chatConversation.id, conversationId));
    expect(closed?.state).toBe('INQUIRY_CLOSED');
  });
});
