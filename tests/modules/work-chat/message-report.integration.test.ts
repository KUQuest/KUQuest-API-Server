import { createApp } from '@/app';
import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import {
  adminEvidenceReference,
  adminReportCase,
  adminReporterEntry,
  reportCaseStatus,
} from '@/database/schema/admin.schema';
import { quest, questAssignment } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { chatConversation, chatMembership, chatMessage } from '@/database/schema/work-chat.schema';
import { auth } from '@/modules/auth';

import { randomUUID } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';
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

const senderId = randomUUID();
const formerReporterId = randomUUID();
const currentReporterId = randomUUID();
const outsiderId = randomUUID();
const tagId = randomUUID();
const fixtureQuestIds: string[] = [];
const fixtureMessageIds: string[] = [];
let postgresAvailable = false;
let reportApp: { handle: (request: Request) => Promise<Response> };

const authenticate = () =>
  spyOn(auth.api, 'getSession').mockImplementation((async ({ headers }: { headers: Headers }) => {
    const memberId = headers.get('x-member-id') ?? senderId;
    return { user: { id: memberId }, session: { userId: memberId } } as never;
  }) as never);

const request = (method: string, path: string, memberId?: string, body?: Record<string, unknown>) =>
  reportApp.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(memberId ? { 'x-member-id': memberId } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  );

const createVisibleWorkConversation = async () => {
  const questId = randomUUID();
  const conversationId = randomUUID();
  const formerAssignmentId = randomUUID();
  const currentAssignmentId = randomUUID();
  const hirerMembershipId = randomUUID();
  const formerMembershipId = randomUUID();
  const currentMembershipId = randomUUID();
  const visibleMessageId = randomUUID();
  const postDepartureMessageId = randomUUID();
  const joinedAt = new Date('2030-01-01T10:00:00.000Z');
  const departedAt = new Date('2030-01-01T10:05:00.000Z');
  const visibleMessageAt = new Date('2030-01-01T10:04:00.000Z');
  const postDepartureMessageAt = new Date('2030-01-01T10:06:00.000Z');

  fixtureQuestIds.push(questId);
  fixtureMessageIds.push(visibleMessageId, postDepartureMessageId);

  await db.insert(quest).values({
    id: questId,
    hirerId: senderId,
    title: 'Message report visibility test',
    condition: 'Create a Message report fixture',
    mode: 'NO_CANDIDATE',
    participation: 'GROUP',
    questStatus: 'QUEST_IN_PROGRESS',
    rewardSatang: 500,
    headcount: 2,
    startTime: joinedAt,
    tagId,
  });
  await db.insert(questAssignment).values([
    {
      id: formerAssignmentId,
      questId,
      workerId: formerReporterId,
      assignmentStatus: 'ASSIGNMENT_CANCELLED',
      createdAt: joinedAt,
    },
    {
      id: currentAssignmentId,
      questId,
      workerId: currentReporterId,
      assignmentStatus: 'ASSIGNMENT_ACTIVE',
      createdAt: joinedAt,
    },
  ]);
  await db.insert(chatConversation).values({
    id: conversationId,
    questId,
    type: 'CONVERSATION_WORK',
    questTitle: 'Message report visibility test',
    questStatus: 'QUEST_IN_PROGRESS',
    nextSequence: 3,
    createdAt: joinedAt,
    updatedAt: postDepartureMessageAt,
  });
  await db.insert(chatMembership).values([
    {
      id: hirerMembershipId,
      conversationId,
      memberId: senderId,
      role: 'HIRER',
      joinedAt,
      createdAt: joinedAt,
    },
    {
      id: formerMembershipId,
      conversationId,
      assignmentId: formerAssignmentId,
      memberId: formerReporterId,
      role: 'WORKER',
      joinedAt,
      leftAt: departedAt,
      createdAt: joinedAt,
    },
    {
      id: currentMembershipId,
      conversationId,
      assignmentId: currentAssignmentId,
      memberId: currentReporterId,
      role: 'WORKER',
      joinedAt,
      createdAt: joinedAt,
    },
  ]);
  await db.insert(chatMessage).values([
    {
      id: visibleMessageId,
      conversationId,
      sequence: 1,
      kind: 'USER',
      senderMembershipId: hirerMembershipId,
      clientMessageId: `report-visible-${visibleMessageId}`,
      contentText: 'A visible message before departure.',
      createdAt: visibleMessageAt,
    },
    {
      id: postDepartureMessageId,
      conversationId,
      sequence: 2,
      kind: 'USER',
      senderMembershipId: hirerMembershipId,
      clientMessageId: `report-hidden-from-former-${postDepartureMessageId}`,
      contentText: 'A message after the former member departed.',
      createdAt: postDepartureMessageAt,
    },
  ]);

  return { conversationId, visibleMessageId, postDepartureMessageId };
};

const createUnauthorizedConversation = async () => {
  const questId = randomUUID();
  const conversationId = randomUUID();
  const membershipId = randomUUID();
  const messageId = randomUUID();
  const createdAt = new Date('2030-01-02T10:00:00.000Z');

  fixtureQuestIds.push(questId);
  fixtureMessageIds.push(messageId);

  await db.insert(quest).values({
    id: questId,
    hirerId: senderId,
    title: 'Other Conversation report test',
    condition: 'Keep the Conversation boundary private',
    mode: 'NO_CANDIDATE',
    participation: 'SOLO',
    questStatus: 'QUEST_IN_PROGRESS',
    rewardSatang: 500,
    headcount: 1,
    startTime: createdAt,
    tagId,
  });
  await db.insert(chatConversation).values({
    id: conversationId,
    questId,
    type: 'CONVERSATION_WORK',
    questTitle: 'Other Conversation report test',
    questStatus: 'QUEST_IN_PROGRESS',
    nextSequence: 2,
    createdAt,
    updatedAt: createdAt,
  });
  await db.insert(chatMembership).values({
    id: membershipId,
    conversationId,
    memberId: outsiderId,
    role: 'HIRER',
    joinedAt: createdAt,
    createdAt,
  });
  await db.insert(chatMessage).values({
    id: messageId,
    conversationId,
    sequence: 1,
    kind: 'USER',
    senderMembershipId: membershipId,
    clientMessageId: `report-other-conversation-${messageId}`,
    contentText: 'A message in another Conversation.',
    createdAt,
  });

  return messageId;
};

const cleanFixtures = async () => {
  if (!postgresAvailable || fixtureQuestIds.length === 0) return;

  await db.transaction(async (transaction) => {
    const cases =
      fixtureMessageIds.length === 0
        ? []
        : await transaction
            .select({ id: adminReportCase.id })
            .from(adminReportCase)
            .where(inArray(adminReportCase.messageId, fixtureMessageIds));
    const caseIds = cases.map(({ id }) => id);
    if (caseIds.length > 0) {
      await transaction
        .delete(adminEvidenceReference)
        .where(inArray(adminEvidenceReference.reportCaseId, caseIds));
      await transaction
        .delete(adminReporterEntry)
        .where(inArray(adminReporterEntry.reportCaseId, caseIds));
      await transaction.delete(adminReportCase).where(inArray(adminReportCase.id, caseIds));
    }
    if (fixtureMessageIds.length > 0) {
      await transaction.delete(chatMessage).where(inArray(chatMessage.id, fixtureMessageIds));
    }
    await transaction
      .delete(chatMembership)
      .where(
        inArray(
          chatMembership.conversationId,
          transaction
            .select({ id: chatConversation.id })
            .from(chatConversation)
            .where(inArray(chatConversation.questId, fixtureQuestIds))
        )
      );
    await transaction
      .delete(chatConversation)
      .where(inArray(chatConversation.questId, fixtureQuestIds));
    await transaction
      .delete(questAssignment)
      .where(inArray(questAssignment.questId, fixtureQuestIds));
    await transaction.delete(quest).where(inArray(quest.id, fixtureQuestIds));
  });

  fixtureQuestIds.length = 0;
  fixtureMessageIds.length = 0;
};

beforeAll(async () => {
  try {
    await sql`select 1`;
  } catch {
    return;
  }

  postgresAvailable = true;
  await db.insert(authUser).values([
    { id: senderId, email: `${senderId}@ku.th`, firstName: 'Report', lastName: 'Sender' },
    {
      id: formerReporterId,
      email: `${formerReporterId}@ku.th`,
      firstName: 'Former',
      lastName: 'Reporter',
    },
    {
      id: currentReporterId,
      email: `${currentReporterId}@ku.th`,
      firstName: 'Current',
      lastName: 'Reporter',
    },
    { id: outsiderId, email: `${outsiderId}@ku.th`, firstName: 'Other', lastName: 'Member' },
  ]);
  await db.insert(tag).values({ id: tagId, name: `Message report ${tagId}` });
});

beforeEach(() => {
  reportApp = createApp();
});

afterEach(async () => {
  mock.restore();
  await cleanFixtures();
});

afterAll(async () => {
  await cleanFixtures();
  if (!postgresAvailable) return;
  await db.delete(tag).where(eq(tag.id, tagId));
  await db
    .delete(authUser)
    .where(inArray(authUser.id, [senderId, formerReporterId, currentReporterId, outsiderId]));
});

describe('Student Message Report API', () => {
  it('requires Member authentication and publishes the documented operations', async () => {
    const responses = await Promise.all([
      request('POST', '/api/v1/chat/reports', undefined, {
        messageId: randomUUID(),
        reason: 'REPORT_SPAM',
      }),
      request('GET', '/api/v1/chat/reports'),
      request('GET', `/api/v1/chat/reports/${randomUUID()}`),
    ]);

    const bodies = await Promise.all(responses.map((response) => response.json()));
    for (const [index, body] of bodies.entries()) {
      expect(responses[index]?.status).toBe(401);
      expect(body.error.code).toBe('UNAUTHORIZED');
    }

    const openApiResponse = await reportApp.handle(new Request('http://localhost/openapi/json'));
    const document = (await openApiResponse.json()) as {
      paths: Record<string, Record<string, { operationId?: string; security?: unknown }>>;
    };
    expect(document.paths['/api/v1/chat/reports']?.post?.operationId).toBe('submitMessageReport');
    expect(document.paths['/api/v1/chat/reports']?.get?.operationId).toBe('listOwnMessageReports');
    expect(document.paths['/api/v1/chat/reports/{reporterEntryId}']?.get?.operationId).toBe(
      'getOwnMessageReport'
    );
    expect(document.paths['/api/v1/chat/reports']?.post?.security).toEqual([
      { betterAuthSession: [] },
    ]);
  });

  it('uses Message visibility, groups reporters, replays duplicates, and protects own status', async () => {
    if (!postgresAvailable) return;
    authenticate();
    const { visibleMessageId, postDepartureMessageId } = await createVisibleWorkConversation();
    const otherConversationMessageId = await createUnauthorizedConversation();

    const first = await request('POST', '/api/v1/chat/reports', formerReporterId, {
      messageId: visibleMessageId,
      reason: 'REPORT_SPAM',
      detail: 'The message repeats the same promotion.',
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      data: {
        reporterEntry: {
          id: string;
          messageId: string;
          reason: string;
          detail: string | null;
          caseStatus: string;
          createdAt: string;
        };
      };
    };
    expect(firstBody.data.reporterEntry).toMatchObject({
      messageId: visibleMessageId,
      reason: 'REPORT_SPAM',
      detail: 'The message repeats the same promotion.',
      caseStatus: 'REPORT_CASE_PENDING',
    });
    expect(firstBody.data.reporterEntry).not.toHaveProperty('reporterMemberId');

    const duplicate = await request('POST', '/api/v1/chat/reports', formerReporterId, {
      messageId: visibleMessageId,
      reason: 'REPORT_OTHER',
      detail: 'This replacement must not overwrite the first report.',
    });
    expect(duplicate.status).toBe(200);
    const duplicateBody = await duplicate.json();
    expect(duplicateBody.data.reporterEntry).toEqual(firstBody.data.reporterEntry);

    const second = await request('POST', '/api/v1/chat/reports', currentReporterId, {
      messageId: visibleMessageId,
      reason: 'REPORT_DANGER_OR_THREAT',
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.data.reporterEntry.caseStatus).toBe('REPORT_CASE_PENDING');
    expect(secondBody.data.reporterEntry.id).not.toBe(firstBody.data.reporterEntry.id);

    const storedCases = await db
      .select({ id: adminReportCase.id, status: adminReportCase.status })
      .from(adminReportCase)
      .where(eq(adminReportCase.messageId, visibleMessageId));
    expect(storedCases).toHaveLength(1);
    expect(storedCases[0]?.status).toBe(reportCaseStatus.pending);
    const storedEntries = await db
      .select({
        reporterMemberId: adminReporterEntry.reporterMemberId,
        reason: adminReporterEntry.reason,
      })
      .from(adminReporterEntry)
      .where(eq(adminReporterEntry.messageId, visibleMessageId));
    expect(storedEntries).toContainEqual({
      reporterMemberId: formerReporterId,
      reason: 'REPORT_SPAM',
    });
    expect(storedEntries).toContainEqual({
      reporterMemberId: currentReporterId,
      reason: 'REPORT_DANGER_OR_THREAT',
    });

    const formerList = await request('GET', '/api/v1/chat/reports', formerReporterId);
    expect(formerList.status).toBe(200);
    const formerListBody = await formerList.json();
    expect(formerListBody.data.items).toHaveLength(1);
    expect(formerListBody.data.items[0]).toEqual(firstBody.data.reporterEntry);
    expect(formerListBody.data.items[0]).not.toHaveProperty('reporterMemberId');

    const currentList = await request('GET', '/api/v1/chat/reports', currentReporterId);
    expect(currentList.status).toBe(200);
    const currentListBody = await currentList.json();
    expect(currentListBody.data.items).toHaveLength(1);
    expect(currentListBody.data.items[0].id).toBe(secondBody.data.reporterEntry.id);

    const otherReportersEntryRead = await request(
      'GET',
      `/api/v1/chat/reports/${firstBody.data.reporterEntry.id}`,
      currentReporterId
    );
    expect(otherReportersEntryRead.status).toBe(404);
    expect((await otherReportersEntryRead.json()).error.code).toBe('REPORTER_ENTRY_NOT_FOUND');

    const postDeparture = await request('POST', '/api/v1/chat/reports', formerReporterId, {
      messageId: postDepartureMessageId,
      reason: 'REPORT_INAPPROPRIATE_CONTENT',
    });
    expect(postDeparture.status).toBe(404);
    expect((await postDeparture.json()).error.code).toBe('MESSAGE_NOT_FOUND');

    const otherConversation = await request('POST', '/api/v1/chat/reports', formerReporterId, {
      messageId: otherConversationMessageId,
      reason: 'REPORT_OTHER',
    });
    expect(otherConversation.status).toBe(404);
    expect((await otherConversation.json()).error.code).toBe('MESSAGE_NOT_FOUND');

    const missing = await request('POST', '/api/v1/chat/reports', formerReporterId, {
      messageId: randomUUID(),
      reason: 'REPORT_OTHER',
    });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe('MESSAGE_NOT_FOUND');

    await db
      .update(adminReportCase)
      .set({
        status: reportCaseStatus.dismissed,
        caseClosedAt: new Date('2030-01-03T10:00:00.000Z'),
        updatedAt: new Date('2030-01-03T10:00:00.000Z'),
      })
      .where(eq(adminReportCase.messageId, visibleMessageId));
    const resolved = await request(
      'GET',
      `/api/v1/chat/reports/${firstBody.data.reporterEntry.id}`,
      formerReporterId
    );
    expect(resolved.status).toBe(200);
    expect((await resolved.json()).data.reporterEntry.caseStatus).toBe('REPORT_CASE_DISMISSED');
  });

  it('rejects invalid report details and unknown body fields', async () => {
    if (!postgresAvailable) return;
    authenticate();
    const { visibleMessageId } = await createVisibleWorkConversation();

    const emptyDetail = await request('POST', '/api/v1/chat/reports', currentReporterId, {
      messageId: visibleMessageId,
      reason: 'REPORT_OTHER',
      detail: '   ',
    });
    expect(emptyDetail.status).toBe(400);

    const unknownField = await request('POST', '/api/v1/chat/reports', currentReporterId, {
      messageId: visibleMessageId,
      reason: 'REPORT_OTHER',
      extra: true,
    });
    expect(unknownField.status).toBe(400);
    expect((await unknownField.json()).error.code).toBe('VALIDATION');
  });
});
