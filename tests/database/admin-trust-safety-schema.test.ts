import { db, sql } from '@/database/client';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import {
  adminEvidenceReference,
  adminModerationDecision,
  adminReportCase,
  adminReporterEntry,
  reportCaseStatus,
  reportCaseStatuses,
} from '@/database/schema/admin.schema';
import { file } from '@/database/schema/file.schema';
import { quest } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import {
  chatAttachment,
  chatConversation,
  chatMembership,
  chatMessage,
  chatMessageAttachment,
} from '@/database/schema/work-chat.schema';

import { randomUUID } from 'node:crypto';

import { eq, getTableColumns, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { getTableConfig } from 'drizzle-orm/pg-core';

const hirerId = randomUUID();
const secondReporterId = randomUUID();
const adminId = randomUUID();
const tagId = randomUUID();
const fixtureQuestIds: string[] = [];
const fixtureConversationIds: string[] = [];
const fixtureMessageIds: string[] = [];
const fixtureAttachmentIds: string[] = [];
const fixtureFileIds: string[] = [];
const fixtureCaseIds: string[] = [];
let postgresAvailable = false;

const createMessageFixture = async () => {
  const questId = randomUUID();
  const conversationId = randomUUID();
  const membershipId = randomUUID();
  const messageId = randomUUID();
  const attachmentId = randomUUID();
  const fileId = randomUUID();
  const createdAt = new Date('2030-01-01T10:00:00.000Z');

  fixtureQuestIds.push(questId);
  fixtureConversationIds.push(conversationId);
  fixtureMessageIds.push(messageId);
  fixtureAttachmentIds.push(attachmentId);
  fixtureFileIds.push(fileId);

  await db.insert(quest).values({
    id: questId,
    hirerId,
    title: 'Trust and Safety schema test',
    condition: 'Create a schema test fixture',
    mode: 'NO_CANDIDATE',
    participation: 'SOLO',
    questStatus: 'QUEST_DRAFT',
    rewardSatang: 500,
    headcount: 1,
    startTime: createdAt,
    tagId,
  });
  await db.insert(chatConversation).values({
    id: conversationId,
    questId,
    type: 'CONVERSATION_WORK',
    questTitle: 'Trust and Safety schema test',
    questStatus: 'QUEST_DRAFT',
  });
  await db.insert(chatMembership).values({
    id: membershipId,
    conversationId,
    memberId: hirerId,
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
    clientMessageId: `schema-test-${messageId}`,
    contentText: 'A message retained for moderation evidence.',
    createdAt,
  });
  await db.insert(file).values({
    id: fileId,
    bucket: 'test-admin-trust-safety',
    objectKey: `admin-trust-safety/${fileId}`,
    contentType: 'image/png',
    sizeBytes: 3,
    uploadedByUserId: hirerId,
  });
  await db.insert(chatAttachment).values({
    id: attachmentId,
    conversationId,
    uploadedByMemberId: membershipId,
    fileId,
    status: 'CONSUMED',
    originalFilename: 'evidence.png',
    mimeType: 'image/png',
    sizeBytes: 3,
    validatedAt: createdAt,
    consumedAt: createdAt,
  });
  await db.insert(chatMessageAttachment).values({
    messageId,
    attachmentId,
    position: 1,
    attachedAt: createdAt,
  });

  return { attachmentId, messageId };
};

const cleanFixtures = async () => {
  if (!postgresAvailable) return;

  if (fixtureCaseIds.length > 0) {
    await db
      .delete(adminModerationDecision)
      .where(inArray(adminModerationDecision.reportCaseId, fixtureCaseIds));
    await db
      .delete(adminEvidenceReference)
      .where(inArray(adminEvidenceReference.reportCaseId, fixtureCaseIds));
    await db
      .delete(adminReporterEntry)
      .where(inArray(adminReporterEntry.reportCaseId, fixtureCaseIds));
    await db.delete(adminReportCase).where(inArray(adminReportCase.id, fixtureCaseIds));
    fixtureCaseIds.length = 0;
  }
  if (fixtureMessageIds.length > 0) {
    await db
      .delete(chatMessageAttachment)
      .where(inArray(chatMessageAttachment.messageId, fixtureMessageIds));
    await db.delete(chatMessage).where(inArray(chatMessage.id, fixtureMessageIds));
    fixtureMessageIds.length = 0;
  }
  if (fixtureAttachmentIds.length > 0) {
    await db.delete(chatAttachment).where(inArray(chatAttachment.id, fixtureAttachmentIds));
    fixtureAttachmentIds.length = 0;
  }
  if (fixtureConversationIds.length > 0) {
    await db
      .delete(chatMembership)
      .where(inArray(chatMembership.conversationId, fixtureConversationIds));
    await db.delete(chatConversation).where(inArray(chatConversation.id, fixtureConversationIds));
    fixtureConversationIds.length = 0;
  }
  if (fixtureQuestIds.length > 0) {
    await db.delete(quest).where(inArray(quest.id, fixtureQuestIds));
    fixtureQuestIds.length = 0;
  }
  if (fixtureFileIds.length > 0) {
    await db.delete(file).where(inArray(file.id, fixtureFileIds));
    fixtureFileIds.length = 0;
  }
};

beforeAll(async () => {
  try {
    await sql`select 1`;
  } catch {
    return;
  }

  postgresAvailable = true;
  await db.insert(authUser).values([
    {
      id: hirerId,
      email: `${hirerId}@ku.th`,
      firstName: 'Schema',
      lastName: 'Hirer',
    },
    {
      id: secondReporterId,
      email: `${secondReporterId}@ku.th`,
      firstName: 'Schema',
      lastName: 'Reporter',
    },
  ]);
  await db.insert(authAdmin).values({
    id: adminId,
    email: `${adminId}@ku.th`,
    firstName: 'Schema',
    lastName: 'Admin',
  });
  await db.insert(tag).values({ id: tagId, name: `Trust and Safety schema ${tagId}` });
});

afterEach(cleanFixtures);

afterAll(async () => {
  await cleanFixtures();
  if (!postgresAvailable) return;
  await db.delete(tag).where(eq(tag.id, tagId));
  await db.delete(authAdmin).where(eq(authAdmin.id, adminId));
  await db.delete(authUser).where(inArray(authUser.id, [hirerId, secondReporterId]));
});

describe('Admin Trust & Safety database schema', () => {
  it('publishes the accepted Report Case status vocabulary and resource columns', () => {
    expect(reportCaseStatuses).toEqual([
      'REPORT_CASE_PENDING',
      'REPORT_CASE_DISMISSED',
      'REPORT_CASE_HIDDEN',
      'REPORT_CASE_RESTORED',
    ]);
    expect(reportCaseStatus.pending).toBe('REPORT_CASE_PENDING');
    expect(getTableColumns(adminReportCase)).toHaveProperty('messageId');
    expect(getTableColumns(adminReportCase)).toHaveProperty('publicSequence');
    expect(getTableColumns(adminReporterEntry)).toHaveProperty('reporterMemberId');
    expect(getTableColumns(adminEvidenceReference)).toHaveProperty('attachmentId');
    expect(getTableColumns(adminModerationDecision)).toHaveProperty('previousStatus');
    expect(
      getTableConfig(adminReportCase).indexes.some(
        (index) => index.config.name === 'admin_report_cases_one_open_message_uidx'
      )
    ).toBe(true);
  });

  it('enforces one open Report Case and one Reporter Entry per Member per Message', async () => {
    if (!postgresAvailable) return;
    const { messageId } = await createMessageFixture();
    const [reportCase] = await db.insert(adminReportCase).values({ messageId }).returning();
    fixtureCaseIds.push(reportCase!.id);
    expect(reportCase!.publicSequence).toBeGreaterThan(0);

    await db.insert(adminReporterEntry).values({
      reportCaseId: reportCase!.id,
      messageId,
      reporterMemberId: hirerId,
      reason: 'REPORT_ABUSIVE_OR_HARASSMENT',
      detail: 'The first report detail.',
    });
    await db.insert(adminReporterEntry).values({
      reportCaseId: reportCase!.id,
      messageId,
      reporterMemberId: secondReporterId,
      reason: 'REPORT_ABUSIVE_OR_HARASSMENT',
    });
    const entries = await db
      .select({
        reporterMemberId: adminReporterEntry.reporterMemberId,
        detail: adminReporterEntry.detail,
      })
      .from(adminReporterEntry)
      .where(eq(adminReporterEntry.reportCaseId, reportCase!.id));
    expect(entries).toHaveLength(2);
    expect(entries).toContainEqual({
      reporterMemberId: hirerId,
      detail: 'The first report detail.',
    });
    expect(entries).toContainEqual({
      reporterMemberId: secondReporterId,
      detail: null,
    });

    const duplicateEntry = await db
      .insert(adminReporterEntry)
      .values({
        reportCaseId: reportCase!.id,
        messageId,
        reporterMemberId: hirerId,
        reason: 'REPORT_ABUSIVE_OR_HARASSMENT',
      })
      .catch((cause) => cause);
    expect(duplicateEntry).toBeInstanceOf(Error);

    const duplicateOpenCase = await db
      .insert(adminReportCase)
      .values({
        messageId,
        status: reportCaseStatus.hidden,
      })
      .catch((cause) => cause);
    expect(duplicateOpenCase).toBeInstanceOf(Error);
  });

  it('allows a new Report Case after the previous case is closed', async () => {
    if (!postgresAvailable) return;
    const { messageId } = await createMessageFixture();
    const [closedCase] = await db
      .insert(adminReportCase)
      .values({
        messageId,
        status: reportCaseStatus.dismissed,
        caseClosedAt: new Date('2030-01-02T10:00:00.000Z'),
      })
      .returning();
    fixtureCaseIds.push(closedCase!.id);

    const [newCase] = await db.insert(adminReportCase).values({ messageId }).returning();
    fixtureCaseIds.push(newCase!.id);
    expect(newCase!.status).toBe(reportCaseStatus.pending);
  });

  it('preserves bounded Message and Attachment Evidence References', async () => {
    if (!postgresAvailable) return;
    const { attachmentId, messageId } = await createMessageFixture();
    const [reportCase] = await db.insert(adminReportCase).values({ messageId }).returning();
    fixtureCaseIds.push(reportCase!.id);

    await db.insert(adminEvidenceReference).values({
      reportCaseId: reportCase!.id,
      messageId,
    });
    await db.insert(adminEvidenceReference).values({
      reportCaseId: reportCase!.id,
      attachmentId,
    });

    const invalidReference = await db
      .insert(adminEvidenceReference)
      .values({
        reportCaseId: reportCase!.id,
      })
      .catch((cause) => cause);
    expect(invalidReference).toBeInstanceOf(Error);
  });

  it('rejects invalid statuses, Reporter Entry reasons, and moderation transitions', async () => {
    if (!postgresAvailable) return;
    const { messageId } = await createMessageFixture();
    const invalidStatus = await db
      .insert(adminReportCase)
      .values({
        messageId,
        status: 'REPORT_CASE_RESOLVED' as never,
      })
      .catch((cause) => cause);
    expect(invalidStatus).toBeInstanceOf(Error);

    const [reportCase] = await db.insert(adminReportCase).values({ messageId }).returning();
    fixtureCaseIds.push(reportCase!.id);

    const invalidReason = await db
      .insert(adminReporterEntry)
      .values({
        reportCaseId: reportCase!.id,
        messageId,
        reporterMemberId: hirerId,
        reason: 'REPORT_SPAM' as never,
      })
      .catch((cause) => cause);
    expect(invalidReason).toBeInstanceOf(Error);

    const invalidTransition = await db
      .insert(adminModerationDecision)
      .values({
        reportCaseId: reportCase!.id,
        adminId,
        previousStatus: reportCaseStatus.pending,
        newStatus: reportCaseStatus.restored,
        reasonCatalogVersion: 1,
        reasonCode: 'MESSAGE_REVIEWED',
      })
      .catch((cause) => cause);
    expect(invalidTransition).toBeInstanceOf(Error);
  });

  it('requires caseClosedAt only for closed Report Cases', async () => {
    if (!postgresAvailable) return;
    const { messageId } = await createMessageFixture();
    const closedTime = new Date('2030-01-02T10:00:00.000Z');

    const openWithClosedTime = await db
      .insert(adminReportCase)
      .values({
        messageId,
        caseClosedAt: closedTime,
      })
      .catch((cause) => cause);
    expect(openWithClosedTime).toBeInstanceOf(Error);

    const closedWithoutClosedTime = await db
      .insert(adminReportCase)
      .values({
        messageId,
        status: reportCaseStatus.dismissed,
      })
      .catch((cause) => cause);
    expect(closedWithoutClosedTime).toBeInstanceOf(Error);
  });
});
