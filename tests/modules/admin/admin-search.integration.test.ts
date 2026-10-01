import { app } from '@/app';
import { db, sql } from '@/database/client';
import {
  adminAction,
  adminConductReport,
  adminConductReportEvidenceHandle,
  adminDisputeCase,
  adminReportCase,
} from '@/database/schema/admin.schema';
import { authUser } from '@/database/schema/auth.schema';
import { quest, questAssignment } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { walletWallet } from '@/database/schema/wallet.schema';
import { chatConversation, chatMembership, chatMessage } from '@/database/schema/work-chat.schema';
import { createAdminAuth } from '@/modules/auth/admin-auth.config';
import {
  formatConductReportDisplayId,
  formatDisputeDisplayId,
  formatQuestDisplayId,
  formatReportCaseDisplayId,
  formatWalletDisplayId,
} from '@/modules/admin/admin-display-id';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';

const adminEmail = `admin-search-test-${crypto.randomUUID()}@example.com`;
const adminPassword = 'AdminSearchPass1!';
const memberId = crypto.randomUUID();
const studentId = String(Math.floor(1000000000 + Math.random() * 9000000000));
const reportedMemberId = crypto.randomUUID();
const restrictionMemberId = crypto.randomUUID();
const restrictionStudentId = String(Math.floor(1000000000 + Math.random() * 9000000000));
const resultLimitMemberIds: string[] = [];
for (let index = 0; index < 13; index += 1) resultLimitMemberIds.push(crypto.randomUUID());
const questId = crypto.randomUUID();
const activityActionId = crypto.randomUUID();
const activityAction = `SEARCH_ACTIVITY_${activityActionId.replaceAll('-', '').toUpperCase()}`;
const walletId = crypto.randomUUID();
const tagId = crypto.randomUUID();
const assignmentId = crypto.randomUUID();
const conversationId = crypto.randomUUID();
const membershipId = crypto.randomUUID();
const messageId = crypto.randomUUID();
const disputeCaseId = crypto.randomUUID();
const reportCaseId = crypto.randomUUID();
const conductReportId = crypto.randomUUID();
const privateMessageContent = `private-search-evidence-${crypto.randomUUID()}`;
const recordCreatedAt = new Date('2030-01-01T10:00:00.000Z');

let questDisplayId = '';
let disputeDisplayId = '';
let reportDisplayId = '';
let conductDisplayId = '';
let walletDisplayId = '';

let adminId = '';
let adminCookie = '';

const searchRequest = (query: string, kind: string) =>
  app.handle(
    new Request(
      `http://localhost/api/v1/admin/search?q=${encodeURIComponent(query)}&kind=${encodeURIComponent(kind)}`,
      { headers: { cookie: adminCookie } }
    )
  );

const expectSearchItem = async (query: string, kind: string, expected: Record<string, string>) => {
  const response = await searchRequest(query, kind);
  expect(response.status).toBe(200);

  const body = await response.json();
  expect(body.success).toBe(true);
  expect(body.data.items).toHaveLength(1);

  const item = body.data.items[0] as Record<string, string>;
  expect(item).toMatchObject(expected);
  expect(item.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  return item;
};
beforeAll(async () => {
  await sql`select 1`;
  await db.insert(authUser).values({
    id: memberId,
    email: `${memberId}@ku.th`,
    firstName: 'Search',
    lastName: 'Member',
    studentId,
    createdAt: recordCreatedAt,
  });

  const adminAuth = createAdminAuth({
    allowSignUp: true,
    autoSignIn: false,
    markEmailVerified: true,
  });
  const signUp = await adminAuth.api.signUpEmail({
    body: {
      email: adminEmail,
      password: adminPassword,
      name: 'Search Admin',
      firstName: 'Search',
      lastName: 'Admin',
    },
  });
  adminId = signUp.user.id;

  const login = await app.handle(
    new Request('http://localhost/api/admin/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: adminPassword }),
    })
  );
  if (login.status !== 200) throw new Error('Admin login failed');
  adminCookie = '';
  for (const setCookie of login.headers.getSetCookie?.() ?? []) {
    const cookie = setCookie.split(';', 1)[0];
    if (cookie) adminCookie = adminCookie ? `${adminCookie}; ${cookie}` : cookie;
  }

  await db.insert(authUser).values({
    id: reportedMemberId,
    email: `${reportedMemberId}@ku.th`,
    firstName: 'Search',
    lastName: 'Reported',
  });

  await db.insert(authUser).values({
    id: restrictionMemberId,
    email: `${restrictionMemberId}@ku.th`,
    firstName: 'Search',
    lastName: 'Restricted',
    studentId: restrictionStudentId,
    redFlagExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
    createdAt: recordCreatedAt,
  });

  const resultLimitMembers: (typeof authUser.$inferInsert)[] = [];
  for (const id of resultLimitMemberIds) {
    resultLimitMembers.push({
      id,
      email: `${id}@ku.th`,
      firstName: 'Search',
      lastName: `Limit ${id.slice(0, 6)}`,
    });
  }
  await db.insert(authUser).values(resultLimitMembers);

  await db.insert(tag).values({
    id: tagId,
    name: `Admin Search ${tagId}`,
  });

  const [questRecord] = await db
    .insert(quest)
    .values({
      id: questId,
      tagId,
      hirerId: memberId,
      title: 'Search Index Quest',
      condition: 'Complete the Admin Search fixture work.',
      mode: 'NO_CANDIDATE',
      participation: 'SOLO',
      questStatus: 'QUEST_OPEN',
      rewardSatang: 500,
      headcount: 1,
      startTime: recordCreatedAt,
      hiddenAt: recordCreatedAt,
      hiddenByAdminId: adminId,
      createdAt: recordCreatedAt,
      updatedAt: recordCreatedAt,
    })
    .returning({ publicSequence: quest.publicSequence });
  if (!questRecord) throw new Error('Quest search fixture was not created');
  questDisplayId = formatQuestDisplayId(questRecord.publicSequence);

  const [walletRecord] = await db
    .insert(walletWallet)
    .values({
      id: walletId,
      userId: memberId,
      walletStatus: 'FROZEN',
      createdAt: recordCreatedAt,
      updatedAt: recordCreatedAt,
    })
    .returning({ publicSequence: walletWallet.publicSequence });
  if (!walletRecord) throw new Error('Wallet search fixture was not created');
  walletDisplayId = formatWalletDisplayId(walletRecord.publicSequence);

  await db.insert(adminAction).values({
    id: activityActionId,
    adminId,
    action: activityAction,
    resourceType: 'wallet',
    resourceId: `activity-resource-${activityActionId}`,
    requestKey: `admin-search-activity-${activityActionId}`,
    requestHash: 'a'.repeat(64),
    reasonCatalogVersion: 1,
    reasonCode: 'SEARCH_TEST',
    metadata: {},
    resultData: {},
    createdAt: recordCreatedAt,
  });

  const [disputeRecord] = await db
    .insert(adminDisputeCase)
    .values({
      id: disputeCaseId,
      questId,
      filerUserId: memberId,
      createdAt: recordCreatedAt,
      updatedAt: recordCreatedAt,
    })
    .returning({ publicSequence: adminDisputeCase.publicSequence });
  if (!disputeRecord) throw new Error('Dispute Case search fixture was not created');
  disputeDisplayId = formatDisputeDisplayId(disputeRecord.publicSequence);

  await db.insert(questAssignment).values({
    id: assignmentId,
    questId,
    workerId: reportedMemberId,
    assignmentStatus: 'ASSIGNMENT_ACTIVE',
    createdAt: recordCreatedAt,
  });

  const [conductRecord] = await db
    .insert(adminConductReport)
    .values({
      id: conductReportId,
      questId,
      filerUserId: memberId,
      reportedMemberId,
      assignmentId,
      reason: 'CONDUCT_ABANDONED',
      createdAt: recordCreatedAt,
      updatedAt: recordCreatedAt,
    })
    .returning({ publicSequence: adminConductReport.publicSequence });
  if (!conductRecord) throw new Error('Conduct Report search fixture was not created');
  conductDisplayId = formatConductReportDisplayId(conductRecord.publicSequence);

  await db.insert(chatConversation).values({
    id: conversationId,
    questId,
    type: 'CONVERSATION_WORK',
    questTitle: 'Search Index Quest',
    questStatus: 'QUEST_OPEN',
    nextSequence: 2,
    createdAt: recordCreatedAt,
    updatedAt: recordCreatedAt,
  });
  await db.insert(chatMembership).values({
    id: membershipId,
    conversationId,
    memberId,
    role: 'HIRER',
    joinedAt: recordCreatedAt,
    createdAt: recordCreatedAt,
  });
  await db.insert(chatMessage).values({
    id: messageId,
    conversationId,
    sequence: 1,
    kind: 'USER',
    senderMembershipId: membershipId,
    clientMessageId: `admin-search-${messageId}`,
    contentText: privateMessageContent,
    createdAt: recordCreatedAt,
  });

  const [reportRecord] = await db
    .insert(adminReportCase)
    .values({
      id: reportCaseId,
      messageId,
      createdAt: recordCreatedAt,
      updatedAt: recordCreatedAt,
    })
    .returning({ publicSequence: adminReportCase.publicSequence });
  if (!reportRecord) throw new Error('Report Case search fixture was not created');
  reportDisplayId = formatReportCaseDisplayId(reportRecord.publicSequence);
});

afterAll(async () => {
  await db.delete(adminReportCase).where(eq(adminReportCase.id, reportCaseId));
  await db
    .delete(adminConductReportEvidenceHandle)
    .where(eq(adminConductReportEvidenceHandle.reportId, conductReportId));
  await db.delete(chatMessage).where(eq(chatMessage.id, messageId));
  await db.delete(chatMembership).where(eq(chatMembership.id, membershipId));
  await db.delete(chatConversation).where(eq(chatConversation.id, conversationId));
  await db.delete(adminConductReport).where(eq(adminConductReport.id, conductReportId));
  await db.delete(adminDisputeCase).where(eq(adminDisputeCase.id, disputeCaseId));
  await db.delete(questAssignment).where(eq(questAssignment.id, assignmentId));
  await db.delete(quest).where(eq(quest.id, questId));
  await db.delete(tag).where(eq(tag.id, tagId));
  await db.delete(authUser).where(eq(authUser.id, restrictionMemberId));
  await db.delete(authUser).where(eq(authUser.id, reportedMemberId));
  await db.delete(authUser).where(inArray(authUser.id, resultLimitMemberIds));
  // The immutable Wallet and Admin Action fixtures keep their owner identities.
});

describe('GET /api/v1/admin/search', () => {
  it('returns a Member Student ID separately and keeps both identifiers as UUIDs', async () => {
    await expectSearchItem(studentId, 'member', {
      kind: 'member',
      id: memberId,
      resourceId: memberId,
      studentId,
      title: 'Search Member',
      status: 'NORMAL',
      newestAt: recordCreatedAt.toISOString(),
    });
  });

  it('returns a canonical restriction status for a Member Search result', async () => {
    await expectSearchItem(restrictionStudentId, 'member', {
      kind: 'member',
      id: restrictionMemberId,
      resourceId: restrictionMemberId,
      studentId: restrictionStudentId,
      title: 'Search Restricted',
      status: 'RED_FLAG',
      newestAt: recordCreatedAt.toISOString(),
    });
  });

  it('searches hidden Quests by readable ID and keeps UUID identifiers', async () => {
    await expectSearchItem(questDisplayId, 'quest', {
      kind: 'quest',
      id: questId,
      resourceId: questId,
      displayId: questDisplayId,
      title: 'Search Index Quest',
      status: 'QUEST_OPEN',
      newestAt: recordCreatedAt.toISOString(),
    });
  });

  it('searches Dispute Cases by readable ID and keeps UUID identifiers', async () => {
    await expectSearchItem(disputeDisplayId, 'dispute', {
      kind: 'dispute',
      id: disputeCaseId,
      resourceId: disputeCaseId,
      displayId: disputeDisplayId,
      title: 'Dispute Case for Search Index Quest',
      status: 'DISPUTE_CASE_PENDING',
      newestAt: recordCreatedAt.toISOString(),
    });
  });

  it('searches Report Cases by readable ID and keeps UUID identifiers', async () => {
    await expectSearchItem(reportDisplayId, 'report', {
      kind: 'report',
      id: reportCaseId,
      resourceId: reportCaseId,
      displayId: reportDisplayId,
      title: `Report Case ${reportDisplayId}`,
      status: 'REPORT_CASE_PENDING',
      newestAt: recordCreatedAt.toISOString(),
    });
  });

  it('searches Conduct Reports by readable ID and keeps UUID identifiers', async () => {
    await expectSearchItem(conductDisplayId, 'conduct-report', {
      kind: 'conduct-report',
      id: conductReportId,
      resourceId: conductReportId,
      displayId: conductDisplayId,
      title: 'Conduct Report for Search Reported',
      status: 'CONDUCT_REPORT_PENDING',
      newestAt: recordCreatedAt.toISOString(),
    });
    const detailResponse = await app.handle(
      new Request(`http://localhost/api/v1/admin/reports/${conductReportId}`, {
        headers: { cookie: adminCookie },
      })
    );
    expect(detailResponse.status).toBe(200);
    const detail = await detailResponse.json();
    expect(detail.data).toMatchObject({
      kind: 'CONDUCT_REPORT',
      id: conductReportId,
      displayId: conductDisplayId,
    });
  });

  it('does not return or search Report Case Message content', async () => {
    const item = await expectSearchItem(reportDisplayId, 'report', {
      kind: 'report',
      id: reportCaseId,
      resourceId: reportCaseId,
      displayId: reportDisplayId,
    });

    expect(Object.keys(item).sort()).toEqual([
      'displayId',
      'id',
      'kind',
      'newestAt',
      'resourceId',
      'status',
      'title',
    ]);
    expect(JSON.stringify(item)).not.toContain(privateMessageContent);

    const response = await searchRequest(privateMessageContent, 'report');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.items).toHaveLength(0);
  });
  it('requires a resource type filter', async () => {
    const response = await app.handle(
      new Request(`http://localhost/api/v1/admin/search?q=${encodeURIComponent(studentId)}`, {
        headers: { cookie: adminCookie },
      })
    );
    expect(response.status).toBe(400);
  });

  it('keeps the existing 12-result limit', async () => {
    const response = await searchRequest('member', 'member');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.items).toHaveLength(12);
  });
  it('searches Wallets by display ID and preserves the UUID used to open them', async () => {
    await expectSearchItem(walletDisplayId, 'wallet', {
      kind: 'wallet',
      id: walletId,
      resourceId: walletId,
      displayId: walletDisplayId,
      title: 'Wallet for Search Member',
      status: 'FROZEN',
      newestAt: recordCreatedAt.toISOString(),
    });
  });

  it('uses the Admin Action UUID for Activity Log results', async () => {
    const response = await searchRequest(activityAction, 'activity');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.items).toHaveLength(1);
    const item = body.data.items[0];
    expect(item).toMatchObject({
      kind: 'activity',
      id: activityActionId,
      resourceId: activityActionId,
      title: activityAction.replaceAll('_', ' '),
      status: null,
      newestAt: recordCreatedAt.toISOString(),
    });
    expect(Object.keys(item).sort()).toEqual([
      'id',
      'kind',
      'newestAt',
      'resourceId',
      'status',
      'title',
    ]);
  });
});
