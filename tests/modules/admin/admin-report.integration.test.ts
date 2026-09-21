import { app } from '@/app';
import { db, sql } from '@/database/client';
import {
  adminAction,
  adminEvidenceReference,
  adminModerationDecision,
  adminReportCase,
  adminReporterEntry,
} from '@/database/schema/admin.schema';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';
import { quest, questAssignment } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import {
  chatAttachment,
  chatConversation,
  chatMembership,
  chatMessage,
  chatMessageAttachment,
} from '@/database/schema/work-chat.schema';
import { auth } from '@/modules/auth';
import { createAdminAuth } from '@/modules/auth/admin-auth.config';
import { workChatStorage } from '@/modules/work-chat';

import { randomUUID } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';
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

let postgresAvailable = false;
let adminCookie = '';
let adminId = '';
const adminEmail = `${randomUUID()}@example.com`;
const adminPassword = 'AdminPass1!';
const reporterId = randomUUID();
const senderId = randomUUID();
const tagId = randomUUID();
const fixtureQuestIds: string[] = [];
const fixtureConversationIds: string[] = [];
const fixtureMessageIds: string[] = [];
const fixtureAttachmentIds: string[] = [];
const fixtureFileIds: string[] = [];
const fixtureCaseIds: string[] = [];

const cookieHeaderFor = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? []).map((cookie) => cookie.split(';', 1)[0]).join('; ');

const adminRequest = (path: string, options: RequestInit = {}) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      ...options,
      headers: {
        cookie: adminCookie,
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...options.headers,
      },
    })
  );

const memberAuthentication = (memberId: string) =>
  spyOn(auth.api, 'getSession').mockImplementation((async () => ({
    user: { id: memberId },
    session: { userId: memberId },
  })) as never);

const createReportFixture = async () => {
  const questId = randomUUID();
  const conversationId = randomUUID();
  const assignmentId = randomUUID();
  const senderMembershipId = randomUUID();
  const reporterMembershipId = randomUUID();
  const messageIds = Array.from({ length: 9 }, () => randomUUID());
  const attachmentId = randomUUID();
  const fileId = randomUUID();
  const caseId = randomUUID();
  const evidenceRefId = randomUUID();
  const createdAt = new Date('2020-02-01T10:00:00.000Z');

  fixtureQuestIds.push(questId);
  fixtureConversationIds.push(conversationId);
  fixtureMessageIds.push(...messageIds);
  fixtureAttachmentIds.push(attachmentId);
  fixtureFileIds.push(fileId);
  fixtureCaseIds.push(caseId);

  await db.insert(quest).values({
    id: questId,
    hirerId: senderId,
    title: `Admin report fixture ${questId}`,
    condition: 'Review the reported Message',
    mode: 'NO_CANDIDATE',
    participation: 'SOLO',
    questStatus: 'QUEST_IN_PROGRESS',
    rewardSatang: 500,
    headcount: 1,
    startTime: createdAt,
    tagId,
  });
  await db.insert(questAssignment).values({
    id: assignmentId,
    questId,
    workerId: reporterId,
    assignmentStatus: 'ASSIGNMENT_ACTIVE',
    createdAt,
  });
  await db.insert(chatConversation).values({
    id: conversationId,
    questId,
    type: 'CONVERSATION_WORK',
    questTitle: `Admin report fixture ${questId}`,
    questStatus: 'QUEST_IN_PROGRESS',
    nextSequence: 10,
    createdAt,
    updatedAt: new Date(createdAt.getTime() + 9 * 60_000),
  });
  await db.insert(chatMembership).values([
    {
      id: senderMembershipId,
      conversationId,
      memberId: senderId,
      role: 'HIRER',
      joinedAt: createdAt,
      createdAt,
    },
    {
      id: reporterMembershipId,
      conversationId,
      assignmentId,
      memberId: reporterId,
      role: 'WORKER',
      joinedAt: createdAt,
      createdAt,
    },
  ]);
  await db.insert(chatMessage).values(
    messageIds.map((id, index) => ({
      id,
      conversationId,
      sequence: index + 1,
      kind: 'USER' as const,
      senderMembershipId,
      clientMessageId: `admin-report-fixture-${id}`,
      contentText: index === 4 ? 'The reported Message content.' : `Context Message ${index + 1}`,
      createdAt: new Date(createdAt.getTime() + index * 60_000),
    }))
  );
  await db.insert(file).values({
    id: fileId,
    bucket: 'admin-report-fixture',
    objectKey: `admin-report-fixture/${fileId}`,
    contentType: 'image/png',
    sizeBytes: 3,
    uploadedByUserId: senderId,
    createdAt,
  });
  await db.insert(chatAttachment).values({
    id: attachmentId,
    conversationId,
    uploadedByMemberId: senderMembershipId,
    fileId,
    status: 'CONSUMED',
    originalFilename: 'reported.png',
    mimeType: 'image/png',
    sizeBytes: 3,
    validatedAt: createdAt,
    consumedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  });
  await db.insert(chatMessageAttachment).values({
    messageId: messageIds[4]!,
    attachmentId,
    position: 1,
    attachedAt: createdAt,
  });
  await db.insert(adminReportCase).values({
    id: caseId,
    messageId: messageIds[4]!,
    createdAt,
    updatedAt: createdAt,
  });
  await db.insert(adminReporterEntry).values({
    id: randomUUID(),
    reportCaseId: caseId,
    messageId: messageIds[4]!,
    reporterMemberId: reporterId,
    reason: 'REPORT_SPAM',
    detail: 'The Message repeats an unwanted promotion.',
    createdAt: new Date(createdAt.getTime() + 1_000),
  });
  await db.insert(adminEvidenceReference).values({
    id: evidenceRefId,
    reportCaseId: caseId,
    messageId: messageIds[4]!,
    createdAt: new Date(createdAt.getTime() + 2_000),
  });

  return {
    caseId,
    evidenceRefId,
    messageId: messageIds[4]!,
    attachmentId,
    conversationId,
    questId,
  };
};

const cleanFixtures = async () => {
  if (!postgresAvailable) return;

  await db.transaction(async (transaction) => {
    if (fixtureCaseIds.length > 0) {
      await transaction
        .delete(adminModerationDecision)
        .where(inArray(adminModerationDecision.reportCaseId, fixtureCaseIds));
      await transaction
        .delete(adminEvidenceReference)
        .where(inArray(adminEvidenceReference.reportCaseId, fixtureCaseIds));
      await transaction
        .delete(adminReporterEntry)
        .where(inArray(adminReporterEntry.reportCaseId, fixtureCaseIds));
      await transaction.delete(adminReportCase).where(inArray(adminReportCase.id, fixtureCaseIds));
    }
    if (fixtureMessageIds.length > 0) {
      await transaction
        .delete(chatMessageAttachment)
        .where(inArray(chatMessageAttachment.messageId, fixtureMessageIds));
      await transaction.delete(chatMessage).where(inArray(chatMessage.id, fixtureMessageIds));
    }
    if (fixtureAttachmentIds.length > 0) {
      await transaction
        .delete(chatAttachment)
        .where(inArray(chatAttachment.id, fixtureAttachmentIds));
    }
    if (fixtureConversationIds.length > 0) {
      await transaction
        .delete(chatMembership)
        .where(inArray(chatMembership.conversationId, fixtureConversationIds));
      await transaction
        .delete(chatConversation)
        .where(inArray(chatConversation.id, fixtureConversationIds));
    }
    if (fixtureQuestIds.length > 0) {
      await transaction
        .delete(questAssignment)
        .where(inArray(questAssignment.questId, fixtureQuestIds));
      await transaction.delete(quest).where(inArray(quest.id, fixtureQuestIds));
    }
    if (fixtureFileIds.length > 0) {
      await transaction.delete(file).where(inArray(file.id, fixtureFileIds));
    }
  });

  fixtureQuestIds.length = 0;
  fixtureConversationIds.length = 0;
  fixtureMessageIds.length = 0;
  fixtureAttachmentIds.length = 0;
  fixtureFileIds.length = 0;
  fixtureCaseIds.length = 0;
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
    { id: reporterId, email: `${reporterId}@ku.th`, firstName: 'Report', lastName: 'Reporter' },
  ]);
  await db.insert(tag).values({ id: tagId, name: `Admin report ${tagId}` });

  const seedAuth = createAdminAuth({
    allowSignUp: true,
    autoSignIn: false,
    markEmailVerified: true,
  });
  await seedAuth.api.signUpEmail({
    body: {
      email: adminEmail,
      password: adminPassword,
      name: 'Report Admin',
      firstName: 'Report',
      lastName: 'Admin',
    },
  });
  const loginResponse = await app.handle(
    new Request('http://localhost/api/admin/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: adminPassword }),
    })
  );
  if (loginResponse.status !== 200)
    throw new Error('Report Admin test session could not be created.');
  adminCookie = cookieHeaderFor(loginResponse);
  const [admin] = await db
    .select({ id: authAdmin.id })
    .from(authAdmin)
    .where(eq(authAdmin.email, adminEmail));
  adminId = admin!.id;
});

afterEach(async () => {
  mock.restore();
  await cleanFixtures();
});

beforeEach(() => {
  spyOn(workChatStorage, 'linkForWithExpiry').mockReturnValue({
    url: 'https://storage.example/report-evidence',
    expiresAt: new Date('2030-02-01T10:15:00.000Z'),
  });
});

afterAll(async () => {
  await cleanFixtures();
  if (!postgresAvailable) return;
  await db.delete(tag).where(eq(tag.id, tagId));
  await db.delete(authUser).where(inArray(authUser.id, [senderId, reporterId]));
});

describe('Admin Report Case API', () => {
  it('publishes the four Admin surfaces and rejects anonymous and Member Sessions', async () => {
    const openApiResponse = await app.handle(new Request('http://localhost/openapi/json'));
    const document = (await openApiResponse.json()) as {
      paths: Record<string, Record<string, { operationId?: string; security?: unknown }>>;
    };
    expect(document.paths['/api/v1/admin/reports']?.get?.operationId).toBe('listAdminReports');
    expect(document.paths['/api/v1/admin/reports/{reportId}']?.get?.operationId).toBe(
      'getAdminReport'
    );
    expect(document.paths['/api/v1/admin/reports/{reportId}/decide']?.post?.operationId).toBe(
      'decideAdminReport'
    );
    expect(document.paths['/api/v1/admin/evidence/{evidenceRef}']?.get?.operationId).toBe(
      'getAdminReportEvidence'
    );

    const anonymous = await app.handle(new Request('http://localhost/api/v1/admin/reports'));
    expect(anonymous.status).toBe(401);
    expect((await anonymous.json()).error.code).toBe('UNAUTHORIZED');

    memberAuthentication(reporterId);
    const member = await app.handle(new Request('http://localhost/api/v1/admin/reports'));
    expect(member.status).toBe(403);
    expect((await member.json()).error.code).toBe('FORBIDDEN');
  });

  it('keeps the queue non-content-bearing, bounds evidence, and audits the evidence read', async () => {
    if (!postgresAvailable) return;
    const fixture = await createReportFixture();

    const list = await adminRequest(`/api/v1/admin/reports?questId=${fixture.questId}`);
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(listBody.data.items).toHaveLength(1);
    expect(listBody.data.items[0]).toMatchObject({
      kind: 'REPORT_CASE',
      id: fixture.caseId,
      displayId: expect.stringMatching(/^RPT-/),
      status: 'REPORT_CASE_PENDING',
      reporterEntries: [
        {
          reason: 'REPORT_SPAM',
          detail: 'The Message repeats an unwanted promotion.',
          reporter: { id: reporterId },
        },
      ],
    });
    expect(listBody.data.items[0]).not.toHaveProperty('contentText');

    const reportedMemberList = await adminRequest(`/api/v1/admin/reports?memberId=${senderId}`);
    expect(reportedMemberList.status).toBe(200);
    expect((await reportedMemberList.json()).data.items).toHaveLength(1);

    const reporterMemberList = await adminRequest(`/api/v1/admin/reports?memberId=${reporterId}`);
    expect(reporterMemberList.status).toBe(200);
    expect((await reporterMemberList.json()).data.items).toHaveLength(0);

    const detail = await adminRequest(`/api/v1/admin/reports/${fixture.caseId}`);
    expect(detail.status).toBe(200);
    expect((await detail.json()).data.messageId).toBe(fixture.messageId);

    const firstEvidence = await adminRequest(`/api/v1/admin/evidence/${fixture.evidenceRefId}`, {
      headers: { 'idempotency-key': `report-evidence-${fixture.caseId}` },
    });
    expect(firstEvidence.status).toBe(200);
    const firstEvidenceBody = await firstEvidence.json();
    expect(firstEvidenceBody.data).toMatchObject({
      caseId: fixture.caseId,
      evidenceRefId: fixture.evidenceRefId,
      reportedMessageId: fixture.messageId,
      truncated: true,
    });
    expect(
      firstEvidenceBody.data.messages.map((message: { sequence: number }) => message.sequence)
    ).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(
      firstEvidenceBody.data.messages.find(
        (message: { id: string }) => message.id === fixture.messageId
      )
    ).toMatchObject({
      contentText: 'The reported Message content.',
      attachments: [
        {
          url: 'https://storage.example/report-evidence',
          urlExpiresAt: '2030-02-01T10:15:00.000Z',
        },
      ],
    });

    const replay = await adminRequest(`/api/v1/admin/evidence/${fixture.evidenceRefId}`, {
      headers: { 'idempotency-key': `report-evidence-${fixture.caseId}` },
    });
    expect(replay.status).toBe(200);
    expect((await replay.json()).data.adminActionId).toBe(firstEvidenceBody.data.adminActionId);
    expect(
      await db
        .select({ id: adminAction.id })
        .from(adminAction)
        .where(
          and(
            eq(adminAction.adminId, adminId),
            eq(adminAction.action, 'REPORT_CASE_EVIDENCE_ACCESS'),
            eq(adminAction.resourceId, fixture.caseId)
          )
        )
    ).toHaveLength(1);

    await db
      .update(chatAttachment)
      .set({ objectDeletedAt: new Date('2030-02-01T10:16:00.000Z') })
      .where(eq(chatAttachment.id, fixture.attachmentId));
    const deletedObjectEvidence = await adminRequest(
      `/api/v1/admin/evidence/${fixture.evidenceRefId}`,
      { headers: { 'idempotency-key': `report-deleted-object-${fixture.caseId}` } }
    );
    expect(deletedObjectEvidence.status).toBe(200);
    expect(
      (await deletedObjectEvidence.json()).data.messages.find(
        (message: { id: string }) => message.id === fixture.messageId
      ).attachments
    ).toEqual([expect.objectContaining({ url: null, urlExpiresAt: null })]);
  });

  it('applies Hide and Restore atomically, hides the Message from other Members, and rejects stale commands', async () => {
    if (!postgresAvailable) return;
    const fixture = await createReportFixture();

    const hideResponses = await Promise.all(
      ['a', 'b'].map((suffix) =>
        adminRequest(`/api/v1/admin/reports/${fixture.caseId}/decide`, {
          method: 'POST',
          headers: {
            'idempotency-key': `report-hide-${suffix}-${fixture.caseId}`,
            'if-match': '1',
          },
          body: JSON.stringify({ outcome: 'REPORT_CASE_HIDDEN', reasonCode: 'SAFETY_REVIEW' }),
        })
      )
    );
    expect(hideResponses.map((response) => response.status).sort()).toEqual([200, 409]);
    const hide = hideResponses.find((response) => response.status === 200)!;
    const concurrentConflict = hideResponses.find((response) => response.status === 409)!;
    expect(hide.status).toBe(200);
    expect((await hide.json()).data.resourceSummary).toMatchObject({
      id: fixture.caseId,
      status: 'REPORT_CASE_HIDDEN',
      version: 2,
    });
    expect((await concurrentConflict.json()).error.code).toBe('ADMIN_ACTION_CONFLICT');

    const [hiddenMessage] = await db
      .select({ hiddenAt: chatMessage.hiddenAt, hiddenByAdminId: chatMessage.hiddenByAdminId })
      .from(chatMessage)
      .where(eq(chatMessage.id, fixture.messageId));
    expect(hiddenMessage).toMatchObject({ hiddenAt: expect.any(Date), hiddenByAdminId: adminId });
    expect(
      await db
        .select({ id: adminModerationDecision.id })
        .from(adminModerationDecision)
        .where(eq(adminModerationDecision.reportCaseId, fixture.caseId))
    ).toHaveLength(1);

    const hiddenEvidence = await adminRequest(`/api/v1/admin/evidence/${fixture.evidenceRefId}`, {
      headers: { 'idempotency-key': `report-hidden-evidence-${fixture.caseId}` },
    });
    expect(hiddenEvidence.status).toBe(200);
    expect((await hiddenEvidence.json()).data.messages).toContainEqual(
      expect.objectContaining({
        id: fixture.messageId,
        contentText: 'The reported Message content.',
      })
    );

    mock.restore();
    memberAuthentication(reporterId);
    const memberMessages = await app.handle(
      new Request(`http://localhost/api/v1/chat/conversations/${fixture.conversationId}/messages`)
    );
    expect(memberMessages.status).toBe(200);
    expect(
      (await memberMessages.json()).data.items.some(
        (message: { id: string }) => message.id === fixture.messageId
      )
    ).toBe(false);
    const hiddenReport = await app.handle(
      new Request('http://localhost/api/v1/chat/reports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: fixture.messageId, reason: 'REPORT_SPAM' }),
      })
    );
    expect(hiddenReport.status).toBe(404);
    expect((await hiddenReport.json()).error.code).toBe('MESSAGE_NOT_FOUND');

    mock.restore();
    memberAuthentication(senderId);
    const senderMessages = await app.handle(
      new Request(`http://localhost/api/v1/chat/conversations/${fixture.conversationId}/messages`)
    );
    expect(senderMessages.status).toBe(200);
    expect(
      (await senderMessages.json()).data.items.some(
        (message: { id: string; text: string }) =>
          message.id === fixture.messageId && message.text === 'The reported Message content.'
      )
    ).toBe(true);

    mock.restore();
    const stale = await adminRequest(`/api/v1/admin/reports/${fixture.caseId}/decide`, {
      method: 'POST',
      headers: {
        'idempotency-key': `report-stale-${fixture.caseId}`,
        'if-match': '1',
      },
      body: JSON.stringify({ outcome: 'REPORT_CASE_DISMISSED', reasonCode: 'POLICY_REVIEW' }),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe('ADMIN_ACTION_CONFLICT');

    const restore = await adminRequest(`/api/v1/admin/reports/${fixture.caseId}/decide`, {
      method: 'POST',
      headers: {
        'idempotency-key': `report-restore-${fixture.caseId}`,
        'if-match': '2',
      },
      body: JSON.stringify({ outcome: 'REPORT_CASE_RESTORED', reasonCode: 'POLICY_REVIEW' }),
    });
    expect(restore.status).toBe(200);
    expect((await restore.json()).data.resourceSummary).toMatchObject({
      status: 'REPORT_CASE_RESTORED',
      version: 3,
    });
    const [restoredMessage] = await db
      .select({ hiddenAt: chatMessage.hiddenAt, hiddenByAdminId: chatMessage.hiddenByAdminId })
      .from(chatMessage)
      .where(eq(chatMessage.id, fixture.messageId));
    expect(restoredMessage).toEqual({ hiddenAt: null, hiddenByAdminId: null });
    expect(
      await db
        .select({ id: adminModerationDecision.id })
        .from(adminModerationDecision)
        .where(eq(adminModerationDecision.reportCaseId, fixture.caseId))
    ).toHaveLength(2);
  });

  it('dismisses a pending Report Case without hiding the Message and rejects a repeated transition', async () => {
    if (!postgresAvailable) return;
    const fixture = await createReportFixture();

    const dismiss = await adminRequest(`/api/v1/admin/reports/${fixture.caseId}/decide`, {
      method: 'POST',
      headers: {
        'idempotency-key': `report-dismiss-${fixture.caseId}`,
        'if-match': '1',
      },
      body: JSON.stringify({ outcome: 'REPORT_CASE_DISMISSED', reasonCode: 'POLICY_REVIEW' }),
    });
    expect(dismiss.status).toBe(200);

    const [row] = await db
      .select({ status: adminReportCase.status, caseClosedAt: adminReportCase.caseClosedAt })
      .from(adminReportCase)
      .where(eq(adminReportCase.id, fixture.caseId));
    expect(row).toMatchObject({ status: 'REPORT_CASE_DISMISSED', caseClosedAt: expect.any(Date) });
    const [message] = await db
      .select({ hiddenAt: chatMessage.hiddenAt })
      .from(chatMessage)
      .where(eq(chatMessage.id, fixture.messageId));
    expect(message).toEqual({ hiddenAt: null });

    const closedEvidence = await adminRequest(`/api/v1/admin/evidence/${fixture.evidenceRefId}`, {
      headers: { 'idempotency-key': `report-closed-evidence-${fixture.caseId}` },
    });
    expect(closedEvidence.status).toBe(404);
    expect((await closedEvidence.json()).error.code).toBe('REPORT_NOT_FOUND');

    const repeated = await adminRequest(`/api/v1/admin/reports/${fixture.caseId}/decide`, {
      method: 'POST',
      headers: {
        'idempotency-key': `report-repeated-${fixture.caseId}`,
        'if-match': '2',
      },
      body: JSON.stringify({ outcome: 'REPORT_CASE_HIDDEN', reasonCode: 'SAFETY_REVIEW' }),
    });
    expect(repeated.status).toBe(409);
    expect((await repeated.json()).error.code).toBe('REPORT_CASE_OUTCOME_INVALID');
    expect(
      await db
        .select({ id: adminModerationDecision.id })
        .from(adminModerationDecision)
        .where(eq(adminModerationDecision.reportCaseId, fixture.caseId))
    ).toHaveLength(1);
  });
});
