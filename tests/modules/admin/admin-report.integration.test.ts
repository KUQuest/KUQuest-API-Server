import { app } from '@/app';
import { db, sql } from '@/database/client';
import {
  adminAction,
  adminConductReport,
  adminConductReportEvidenceHandle,
  adminEvidenceReference,
  adminModerationDecision,
  adminReportCase,
  adminReporterEntry,
  conductReportReason,
  memberPenaltyRecord,
} from '@/database/schema/admin.schema';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';
import { pushDelivery } from '@/database/schema/push.schema';
import {
  quest,
  questAssignment,
  questCandidateTeamV2,
  questCandidateTeamV2Member,
  questV2ProofSubmission,
} from '@/database/schema/quest.schema';
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
const additionalWorkerId = randomUUID();
const unrelatedCandidateId = randomUUID();
const tagId = randomUUID();
const fixtureQuestIds: string[] = [];
const fixtureConversationIds: string[] = [];
const fixtureMessageIds: string[] = [];
const fixtureAttachmentIds: string[] = [];
const fixtureFileIds: string[] = [];
const fixtureCaseIds: string[] = [];
const fixtureConductReportIds: string[] = [];
const fixtureConductQuestIds: string[] = [];
const fixtureConductAssignmentIds: string[] = [];
const penaltyMemberIds = new Set<string>();

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

const createConductReportFixture = async (
  input: {
    mode?: 'FIRST_COME_FIRST_SERVED' | 'CANDIDATE';
    participation?: 'SINGLE' | 'GROUP';
    reason?: (typeof conductReportReason)[keyof typeof conductReportReason];
    filerId?: string;
    reportedMemberId?: string;
    assignmentWorkerId?: string;
    assignmentWorkerIds?: string[];
    candidateTeamLeaderId?: string;
    includeTeamProof?: boolean;
    includeDraftProof?: boolean;
  } = {}
) => {
  const questId = randomUUID();
  const reportId = randomUUID();
  const createdAt = new Date('2020-02-02T10:00:00.000Z');
  const mode = input.mode ?? 'FIRST_COME_FIRST_SERVED';
  const participation = input.participation ?? 'SINGLE';
  const filerId = input.filerId ?? senderId;
  const reportedMemberId = input.reportedMemberId ?? reporterId;
  const assignmentWorkerId = input.assignmentWorkerId ?? reportedMemberId;
  const assignmentWorkerIds = [...new Set(input.assignmentWorkerIds ?? [assignmentWorkerId])];

  fixtureConductReportIds.push(reportId);
  fixtureConductQuestIds.push(questId);

  await db.insert(quest).values({
    id: questId,
    hirerId: senderId,
    apiVersion: 'v2',
    title: `Conduct report fixture ${questId}`,
    condition: 'Complete the reported Quest work.',
    mode: mode === 'CANDIDATE' ? 'CANDIDATE' : 'NO_CANDIDATE',
    participation: participation === 'GROUP' ? 'GROUP' : 'SOLO',
    v2Mode: mode,
    v2Participation: participation,
    questStatus: 'QUEST_IN_PROGRESS',
    rewardSatang: participation === 'GROUP' ? 2_000 : 1_000,
    questFundingTotalSatang: participation === 'GROUP' ? 2_000 : 1_000,
    questEscrowSatang: participation === 'GROUP' ? 2_040 : 1_020,
    headcount: participation === 'GROUP' ? 2 : 1,
    startTime: createdAt,
    dueAt: new Date(createdAt.getTime() + 60 * 60 * 1000),
    tagId,
  });
  const assignmentRows = await db
    .insert(questAssignment)
    .values(
      assignmentWorkerIds.map((workerId) => ({
        questId,
        workerId,
        assignmentStatus: 'ASSIGNMENT_ACTIVE' as const,
        createdAt,
      }))
    )
    .returning({ id: questAssignment.id, workerId: questAssignment.workerId });
  fixtureConductAssignmentIds.push(...assignmentRows.map(({ id }) => id));
  const assignmentId = assignmentRows.find(
    (assignment) => assignment.workerId === assignmentWorkerId
  )?.id;
  if (!assignmentId) throw new Error('Conduct Report test Assignment was not created.');

  let candidateTeamId: string | undefined;
  let proofSubmissionId: string | undefined;
  let draftProofSubmissionId: string | undefined;
  if (mode === 'CANDIDATE' && participation === 'GROUP') {
    const leaderId = input.candidateTeamLeaderId;
    if (!leaderId || !assignmentWorkerIds.includes(leaderId) || assignmentWorkerIds.length < 2) {
      throw new Error('GROUP + CANDIDATE test fixtures need a selected two-member Team.');
    }

    candidateTeamId = randomUUID();
    await db.insert(questCandidateTeamV2).values({
      id: candidateTeamId,
      questId,
      leaderId,
      name: 'Admin Report test Team',
      headcount: assignmentWorkerIds.length,
      state: 'TEAM_SELECTED',
      submissionText: 'Candidate Team proof.',
      submittedAt: createdAt,
      createdAt,
    });
    await db.insert(questCandidateTeamV2Member).values(
      assignmentWorkerIds.map((memberId) => ({
        teamId: candidateTeamId!,
        memberId,
        joinedAt: createdAt,
      }))
    );

    if (input.includeTeamProof) {
      proofSubmissionId = randomUUID();
      await db.insert(questV2ProofSubmission).values({
        id: proofSubmissionId,
        questId,
        teamId: candidateTeamId,
        submittedByUserId: leaderId,
        description: 'Team Proof Submission description.',
        workerMessage: 'Team Proof Submission message.',
        submissionStatus: 'PROOF_PENDING',
        sentAt: createdAt,
        createdAt,
        updatedAt: createdAt,
      });
    }
  }

  if (input.includeDraftProof) {
    draftProofSubmissionId = randomUUID();
    await db.insert(questV2ProofSubmission).values({
      id: draftProofSubmissionId,
      questId,
      workerId: assignmentWorkerId,
      teamId: null,
      submittedByUserId: assignmentWorkerId,
      description: 'Private unsent Proof Submission draft.',
      workerMessage: 'Private unsent Worker Message.',
      submissionStatus: null,
      sentAt: null,
      createdAt,
      updatedAt: createdAt,
    });
  }

  await db.insert(adminConductReport).values({
    id: reportId,
    questId,
    filerUserId: filerId,
    reportedMemberId,
    assignmentId,
    reason: input.reason ?? conductReportReason.abandoned,
    detail: 'The Quest record requires Admin review.',
    createdAt,
    updatedAt: createdAt,
  });

  return {
    assignmentId,
    assignmentWorkerIds,
    candidateTeamId,
    proofSubmissionId,
    draftProofSubmissionId,
    filerId,
    reportedMemberId,
    questId,
    reportId,
  };
};

const createConductReportChatFixture = async (
  fixture: Awaited<ReturnType<typeof createConductReportFixture>>,
  input: { messageCount?: number; candidateWorkerIds?: string[]; attachmentSequence?: number } = {}
) => {
  const createdAt = new Date('2020-02-02T10:00:00.000Z');
  const messageCount = input.messageCount ?? 0;
  const workConversationId = randomUUID();
  const hirerMembershipId = randomUUID();
  const workMessageIds = Array.from({ length: messageCount }, () => randomUUID());
  const candidateConversationIds: string[] = [];

  fixtureConversationIds.push(workConversationId);
  fixtureMessageIds.push(...workMessageIds);

  await db.insert(chatConversation).values({
    id: workConversationId,
    questId: fixture.questId,
    type: 'CONVERSATION_WORK',
    questTitle: `Conduct report fixture ${fixture.questId}`,
    questStatus: 'QUEST_IN_PROGRESS',
    nextSequence: messageCount + 1,
    createdAt,
    updatedAt: new Date(createdAt.getTime() + messageCount * 60_000),
  });

  const assignments = await db
    .select({ id: questAssignment.id, workerId: questAssignment.workerId })
    .from(questAssignment)
    .where(eq(questAssignment.questId, fixture.questId));
  await db.insert(chatMembership).values([
    {
      id: hirerMembershipId,
      conversationId: workConversationId,
      memberId: senderId,
      role: 'HIRER',
      joinedAt: createdAt,
      createdAt,
    },
    ...assignments.map((assignment) => ({
      id: randomUUID(),
      conversationId: workConversationId,
      assignmentId: assignment.id,
      memberId: assignment.workerId,
      role: 'WORKER' as const,
      joinedAt: createdAt,
      createdAt,
    })),
  ]);

  if (workMessageIds.length > 0) {
    await db.insert(chatMessage).values(
      workMessageIds.map((id, index) => ({
        id,
        conversationId: workConversationId,
        sequence: index + 1,
        kind: 'USER' as const,
        senderMembershipId: hirerMembershipId,
        clientMessageId: `conduct-report-history-${id}`,
        contentText: `Conduct Report history message ${index + 1}`,
        createdAt: new Date(createdAt.getTime() + (index + 1) * 60_000),
      }))
    );
  }

  if (input.attachmentSequence) {
    const messageId = workMessageIds[input.attachmentSequence - 1];
    if (!messageId)
      throw new Error('Attachment sequence is outside the Work Conversation history.');
    const attachmentId = randomUUID();
    const fileId = randomUUID();
    fixtureAttachmentIds.push(attachmentId);
    fixtureFileIds.push(fileId);
    await db.insert(file).values({
      id: fileId,
      bucket: 'conduct-report-fixture',
      objectKey: `conduct-report-fixture/${fileId}`,
      contentType: 'image/png',
      sizeBytes: 3,
      uploadedByUserId: senderId,
      createdAt,
    });
    await db.insert(chatAttachment).values({
      id: attachmentId,
      conversationId: workConversationId,
      uploadedByMemberId: hirerMembershipId,
      fileId,
      status: 'CONSUMED',
      originalFilename: 'conduct-evidence.png',
      mimeType: 'image/png',
      sizeBytes: 3,
      validatedAt: createdAt,
      consumedAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    });
    await db.insert(chatMessageAttachment).values({
      messageId,
      attachmentId,
      position: 1,
      attachedAt: createdAt,
    });
  }

  for (const candidateWorkerId of new Set(input.candidateWorkerIds ?? [])) {
    if (candidateWorkerId === senderId) continue;
    const conversationId = randomUUID();
    const hirerInquiryMembershipId = randomUUID();
    const candidateMembershipId = randomUUID();
    const messageId = randomUUID();
    candidateConversationIds.push(conversationId);
    fixtureConversationIds.push(conversationId);
    fixtureMessageIds.push(messageId);

    // eslint-disable-next-line no-await-in-loop
    await db.insert(chatConversation).values({
      id: conversationId,
      questId: fixture.questId,
      type: 'CONVERSATION_CANDIDATE_INQUIRY',
      questTitle: `Conduct report fixture ${fixture.questId}`,
      questStatus: 'QUEST_ASSIGNED',
      state: 'INQUIRY_CLOSED',
      candidateWorkerId,
      closedAt: createdAt,
      nextSequence: 2,
      createdAt,
      updatedAt: createdAt,
    });
    // eslint-disable-next-line no-await-in-loop
    await db.insert(chatMembership).values([
      {
        id: hirerInquiryMembershipId,
        conversationId,
        memberId: senderId,
        role: 'HIRER',
        joinedAt: createdAt,
        createdAt,
      },
      {
        id: candidateMembershipId,
        conversationId,
        memberId: candidateWorkerId,
        role: 'PROSPECTIVE_WORKER',
        joinedAt: createdAt,
        createdAt,
      },
    ]);
    // eslint-disable-next-line no-await-in-loop
    await db.insert(chatMessage).values({
      id: messageId,
      conversationId,
      sequence: 1,
      kind: 'USER',
      senderMembershipId: candidateMembershipId,
      clientMessageId: `conduct-candidate-inquiry-${messageId}`,
      contentText: `Candidate Inquiry from ${candidateWorkerId}`,
      createdAt: new Date(createdAt.getTime() + 60_000),
    });
  }

  return { workConversationId, workMessageIds, candidateConversationIds };
};

const cleanFixtures = async () => {
  if (!postgresAvailable) return;

  await db.transaction(async (transaction) => {
    const penaltySourceIds = [...fixtureConductReportIds, ...fixtureCaseIds];
    if (penaltySourceIds.length > 0) {
      const penaltyMembers = await transaction
        .select({ memberId: memberPenaltyRecord.memberId })
        .from(memberPenaltyRecord)
        .where(inArray(memberPenaltyRecord.sourceId, penaltySourceIds));
      for (const penaltyMember of penaltyMembers) {
        penaltyMemberIds.add(penaltyMember.memberId);
      }
    }
    if (fixtureConductReportIds.length > 0) {
      await transaction.delete(pushDelivery).where(
        inArray(
          pushDelivery.eventKey,
          fixtureConductReportIds.map((reportId) => `conduct-report-upheld:${reportId}`)
        )
      );
      await transaction
        .delete(adminConductReportEvidenceHandle)
        .where(inArray(adminConductReportEvidenceHandle.reportId, fixtureConductReportIds));
      await transaction
        .delete(adminConductReport)
        .where(inArray(adminConductReport.id, fixtureConductReportIds));
    }
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
    if (fixtureConductAssignmentIds.length > 0) {
      await transaction
        .delete(questAssignment)
        .where(inArray(questAssignment.id, fixtureConductAssignmentIds));
    }
    if (fixtureConductQuestIds.length > 0) {
      await transaction.delete(quest).where(inArray(quest.id, fixtureConductQuestIds));
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
  fixtureConductReportIds.length = 0;
  fixtureConductQuestIds.length = 0;
  fixtureConductAssignmentIds.length = 0;
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
    {
      id: additionalWorkerId,
      email: `${additionalWorkerId}@ku.th`,
      firstName: 'Report',
      lastName: 'Additional Worker',
    },
    {
      id: unrelatedCandidateId,
      email: `${unrelatedCandidateId}@ku.th`,
      firstName: 'Report',
      lastName: 'Unrelated Candidate',
    },
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
  const removableMemberIds = [reporterId, additionalWorkerId, unrelatedCandidateId].filter(
    (memberId) => !penaltyMemberIds.has(memberId)
  );
  if (removableMemberIds.length > 0) {
    await db.delete(authUser).where(inArray(authUser.id, removableMemberIds));
  }
});

describe('Admin Report Case API', () => {
  it('publishes the four Admin surfaces and rejects anonymous and Member Sessions', async () => {
    const openApiResponse = await app.handle(new Request('http://localhost/openapi/json'));
    const document = (await openApiResponse.json()) as {
      paths: Record<
        string,
        Record<
          string,
          {
            operationId?: string;
            security?: unknown;
            requestBody?: { content?: Record<string, { schema?: unknown }> };
            responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
          }
        >
      >;
    };
    const listOperation = document.paths['/api/v1/admin/reports']?.get;
    const detailOperation = document.paths['/api/v1/admin/reports/{reportId}']?.get;
    const decisionOperation = document.paths['/api/v1/admin/reports/{reportId}/decide']?.post;
    expect(listOperation?.operationId).toBe('listAdminReports');
    expect(document.paths['/api/v1/admin/reports/{reportId}']?.get?.operationId).toBe(
      'getAdminReport'
    );
    expect(decisionOperation?.operationId).toBe('decideAdminReport');
    expect(document.paths['/api/v1/admin/evidence/{evidenceRef}']?.get?.operationId).toBe(
      'getAdminReportEvidence'
    );

    const listSchema = listOperation?.responses?.['200']?.content?.['application/json']?.schema;
    const detailSchema = detailOperation?.responses?.['200']?.content?.['application/json']?.schema;
    const decisionRequestSchema =
      decisionOperation?.requestBody?.content?.['application/json']?.schema;
    expect(JSON.stringify(listSchema)).toContain('REPORT_CASE');
    expect(JSON.stringify(listSchema)).toContain('CONDUCT_REPORT');
    expect(JSON.stringify(detailSchema)).toContain('REPORT_CASE');
    expect(JSON.stringify(detailSchema)).toContain('CONDUCT_REPORT');
    expect(JSON.stringify(detailSchema)).toContain('assignment');
    expect(JSON.stringify(detailSchema)).toContain('proofSubmission');
    expect(JSON.stringify(decisionRequestSchema)).toContain('CONDUCT_REPORT_DISMISSED');
    expect(JSON.stringify(decisionRequestSchema)).toContain('CONDUCT_REPORT_UPHELD');
    expect(JSON.stringify(decisionRequestSchema)).toContain('CONDUCT_REPORT_NO_VIOLATION');
    expect(JSON.stringify(decisionRequestSchema)).toContain('CONDUCT_REPORT_INSUFFICIENT_EVIDENCE');

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
    expect((await detail.json()).data).toMatchObject({
      kind: 'REPORT_CASE',
      messageId: fixture.messageId,
    });

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

  it('lists and details a Conduct Report with its Quest record discriminator', async () => {
    if (!postgresAvailable) return;
    const fixture = await createConductReportFixture();

    const list = await adminRequest(
      `/api/v1/admin/reports?kind=CONDUCT_REPORT&status=CONDUCT_REPORT_PENDING&memberId=${reporterId}&questId=${fixture.questId}`
    );
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(listBody.data.items).toHaveLength(1);
    expect(listBody.data.items[0]).toMatchObject({
      kind: 'CONDUCT_REPORT',
      id: fixture.reportId,
      displayId: expect.stringMatching(/^CND-\d{6}$/),
      filer: { id: senderId },
      reportedMember: { id: reporterId },
      quest: {
        id: fixture.questId,
        mode: 'FIRST_COME_FIRST_SERVED',
        participation: 'SINGLE',
      },
      reason: 'CONDUCT_ABANDONED',
      status: 'CONDUCT_REPORT_PENDING',
      version: 1,
    });
    expect(listBody.data.items[0]).not.toHaveProperty('assignment');

    const detail = await adminRequest(`/api/v1/admin/reports/${fixture.reportId}`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody.data).toMatchObject({
      kind: 'CONDUCT_REPORT',
      id: fixture.reportId,
      displayId: expect.stringMatching(/^CND-\d{6}$/),
      assignment: {
        id: fixture.assignmentId,
        worker: { id: reporterId },
        assignmentStatus: 'ASSIGNMENT_ACTIVE',
      },
      proofSubmission: null,
      detail: 'The Quest record requires Admin review.',
    });
  });

  it('does not expose an unsent v2 Proof Submission draft in Conduct Report detail', async () => {
    if (!postgresAvailable) return;
    const fixture = await createConductReportFixture({
      mode: 'CANDIDATE',
      participation: 'SINGLE',
      filerId: reporterId,
      reportedMemberId: senderId,
      assignmentWorkerId: reporterId,
      includeDraftProof: true,
    });
    expect(fixture.draftProofSubmissionId).toBeDefined();

    const detail = await adminRequest(`/api/v1/admin/reports/${fixture.reportId}`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody.data.proofSubmission).toBeNull();
    expect(JSON.stringify(detailBody)).not.toContain('Private unsent Proof Submission draft.');
    expect(JSON.stringify(detailBody)).not.toContain('Private unsent Worker Message.');
  });

  it('lists all Quest mode and participation combinations and all Conduct Report reasons', async () => {
    if (!postgresAvailable) return;
    const cases = [
      {
        mode: 'FIRST_COME_FIRST_SERVED' as const,
        participation: 'SINGLE' as const,
        reason: conductReportReason.abandoned,
        filerId: senderId,
        reportedMemberId: reporterId,
      },
      {
        mode: 'CANDIDATE' as const,
        participation: 'SINGLE' as const,
        reason: conductReportReason.outOfScope,
        filerId: reporterId,
        reportedMemberId: senderId,
        assignmentWorkerId: reporterId,
      },
      {
        mode: 'FIRST_COME_FIRST_SERVED' as const,
        participation: 'GROUP' as const,
        reason: conductReportReason.noShow,
        filerId: reporterId,
        reportedMemberId: additionalWorkerId,
        assignmentWorkerIds: [reporterId, additionalWorkerId],
      },
      {
        mode: 'CANDIDATE' as const,
        participation: 'GROUP' as const,
        reason: conductReportReason.outOfScope,
        filerId: additionalWorkerId,
        reportedMemberId: senderId,
        assignmentWorkerId: additionalWorkerId,
        assignmentWorkerIds: [reporterId, additionalWorkerId],
        candidateTeamLeaderId: reporterId,
        includeTeamProof: true,
      },
    ];

    for (const scenario of cases) {
      // Each response checks a valid Rulebook relationship through the Admin HTTP boundary.
      // eslint-disable-next-line no-await-in-loop
      const fixture = await createConductReportFixture(scenario);
      // eslint-disable-next-line no-await-in-loop
      const response = await adminRequest(
        '/api/v1/admin/reports?' +
          new URLSearchParams({
            kind: 'CONDUCT_REPORT',
            questId: fixture.questId,
          }).toString()
      );
      expect(response.status).toBe(200);
      // eslint-disable-next-line no-await-in-loop
      const body = await response.json();
      expect(body.data.items).toHaveLength(1);
      expect(body.data.items[0]).toMatchObject({
        kind: 'CONDUCT_REPORT',
        id: fixture.reportId,
        quest: {
          mode: scenario.mode,
          participation: scenario.participation,
        },
        reason: scenario.reason,
      });
      expect(body.data.items[0]).not.toHaveProperty('proofSubmission');

      if (fixture.proofSubmissionId) {
        // eslint-disable-next-line no-await-in-loop
        const detail = await adminRequest('/api/v1/admin/reports/' + fixture.reportId);
        expect(detail.status).toBe(200);
        // eslint-disable-next-line no-await-in-loop
        const detailBody = await detail.json();
        expect(detailBody.data.proofSubmission).toMatchObject({
          id: fixture.proofSubmissionId,
          teamId: fixture.candidateTeamId,
          submittedBy: { id: reporterId },
          description: 'Team Proof Submission description.',
          workerMessage: 'Team Proof Submission message.',
          submissionStatus: 'PROOF_PENDING',
        });
      }
    }
  });

  it('exposes case-scoped handles and paginates Work history for all Quest shapes', async () => {
    if (!postgresAvailable) return;
    const scenarios = [
      {
        mode: 'FIRST_COME_FIRST_SERVED' as const,
        participation: 'SINGLE' as const,
        reason: conductReportReason.abandoned,
        filerId: senderId,
        reportedMemberId: reporterId,
      },
      {
        mode: 'CANDIDATE' as const,
        participation: 'SINGLE' as const,
        reason: conductReportReason.outOfScope,
        filerId: reporterId,
        reportedMemberId: senderId,
        assignmentWorkerId: reporterId,
      },
      {
        mode: 'FIRST_COME_FIRST_SERVED' as const,
        participation: 'GROUP' as const,
        reason: conductReportReason.noShow,
        filerId: reporterId,
        reportedMemberId: additionalWorkerId,
        assignmentWorkerIds: [reporterId, additionalWorkerId],
      },
      {
        mode: 'CANDIDATE' as const,
        participation: 'GROUP' as const,
        reason: conductReportReason.abandoned,
        filerId: senderId,
        reportedMemberId: reporterId,
        assignmentWorkerIds: [reporterId, additionalWorkerId],
        candidateTeamLeaderId: reporterId,
      },
    ];

    for (const scenario of scenarios) {
      // Each shape gets separate persisted Chat data and Admin evidence reads.
      // eslint-disable-next-line no-await-in-loop
      const fixture = await createConductReportFixture(scenario);
      const candidateWorkerIds = [fixture.filerId, fixture.reportedMemberId].filter(
        (memberId) => memberId !== senderId
      );
      // eslint-disable-next-line no-await-in-loop
      await createConductReportChatFixture(fixture, {
        messageCount: 2,
        candidateWorkerIds,
      });

      // eslint-disable-next-line no-await-in-loop
      const detailResponse = await adminRequest(`/api/v1/admin/reports/${fixture.reportId}`);
      expect(detailResponse.status).toBe(200);
      // eslint-disable-next-line no-await-in-loop
      const detail = (await detailResponse.json()).data;
      const workHandle = detail.evidenceHandles.find(
        (handle: { conversationType: string }) => handle.conversationType === 'CONVERSATION_WORK'
      );
      expect(workHandle.handle).toMatch(/^CRH_[A-Za-z0-9_-]{43}$/);
      expect(
        detail.evidenceHandles.filter(
          (handle: { conversationType: string }) =>
            handle.conversationType === 'CONVERSATION_CANDIDATE_INQUIRY'
        )
      ).toHaveLength(candidateWorkerIds.length);

      // eslint-disable-next-line no-await-in-loop
      const firstPage = await adminRequest(`/api/v1/admin/evidence/${workHandle.handle}?limit=1`, {
        headers: { 'idempotency-key': `conduct-page-one-${fixture.reportId}` },
      });
      expect(firstPage.status).toBe(200);
      // eslint-disable-next-line no-await-in-loop
      const firstPageBody = (await firstPage.json()).data;
      expect(
        firstPageBody.messages.map((message: { sequence: number }) => message.sequence)
      ).toEqual([1]);
      expect(firstPageBody.nextCursor).toEqual(expect.any(String));

      const secondPageQuery = new URLSearchParams({ limit: '1', cursor: firstPageBody.nextCursor });
      // eslint-disable-next-line no-await-in-loop
      const secondPage = await adminRequest(
        `/api/v1/admin/evidence/${workHandle.handle}?${secondPageQuery}`,
        { headers: { 'idempotency-key': `conduct-page-two-${fixture.reportId}` } }
      );
      expect(secondPage.status).toBe(200);
      // eslint-disable-next-line no-await-in-loop
      const secondPageBody = (await secondPage.json()).data;
      expect(
        secondPageBody.messages.map((message: { sequence: number }) => message.sequence)
      ).toEqual([2]);
      expect(secondPageBody.nextCursor).toBeNull();
    }
  });

  it('limits Candidate Inquiry access, audits each page and Attachment link, and enforces retention', async () => {
    if (!postgresAvailable) return;
    const fixture = await createConductReportFixture({
      mode: 'FIRST_COME_FIRST_SERVED',
      participation: 'GROUP',
      reason: conductReportReason.noShow,
      filerId: reporterId,
      reportedMemberId: additionalWorkerId,
      assignmentWorkerId: reporterId,
      assignmentWorkerIds: [reporterId, additionalWorkerId],
    });
    const conversations = await createConductReportChatFixture(fixture, {
      messageCount: 5,
      attachmentSequence: 2,
      candidateWorkerIds: [reporterId, additionalWorkerId, unrelatedCandidateId],
    });
    const detailResponse = await adminRequest(`/api/v1/admin/reports/${fixture.reportId}`);
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()).data;
    const workHandle = detail.evidenceHandles.find(
      (handle: { conversationType: string }) => handle.conversationType === 'CONVERSATION_WORK'
    );
    const candidateHandles = detail.evidenceHandles.filter(
      (handle: { conversationType: string }) =>
        handle.conversationType === 'CONVERSATION_CANDIDATE_INQUIRY'
    );
    expect(
      candidateHandles.map((handle: { candidate: { id: string } }) => handle.candidate.id).sort()
    ).toEqual([reporterId, additionalWorkerId].sort());
    const reportedCandidateHandle = candidateHandles.find(
      (handle: { candidate: { id: string } }) => handle.candidate.id === reporterId
    );
    const otherCandidateHandle = candidateHandles.find(
      (handle: { candidate: { id: string } }) => handle.candidate.id === additionalWorkerId
    );

    const initialMemberships = await db
      .select({ id: chatMembership.id })
      .from(chatMembership)
      .where(
        inArray(
          chatMembership.conversationId,
          conversations.candidateConversationIds.concat(conversations.workConversationId)
        )
      );
    const pages: Array<{
      messages: Array<{ sequence: number; attachments: unknown[] }>;
      nextCursor: string | null;
    }> = [];
    let cursor: string | null = null;
    for (let index = 0; index < 3; index += 1) {
      const query = new URLSearchParams({ limit: '2' });
      if (cursor) query.set('cursor', cursor);
      // eslint-disable-next-line no-await-in-loop
      const response = await adminRequest(`/api/v1/admin/evidence/${workHandle.handle}?${query}`, {
        headers: { 'idempotency-key': `conduct-history-${index}-${fixture.reportId}` },
      });
      expect(response.status).toBe(200);
      // eslint-disable-next-line no-await-in-loop
      const body = (await response.json()).data;
      pages.push(body);
      cursor = body.nextCursor;
    }
    expect(pages.map((page) => page.messages.map((message) => message.sequence))).toEqual([
      [1, 2],
      [3, 4],
      [5],
    ]);
    expect(pages[0]!.messages[1]!.attachments).toEqual([
      expect.objectContaining({
        originalFilename: 'conduct-evidence.png',
        url: 'https://storage.example/report-evidence',
        urlExpiresAt: '2030-02-01T10:15:00.000Z',
      }),
    ]);
    expect(pages[2]!.nextCursor).toBeNull();

    const candidatePage = await adminRequest(
      `/api/v1/admin/evidence/${reportedCandidateHandle.handle}?limit=2`,
      { headers: { 'idempotency-key': `conduct-candidate-page-${fixture.reportId}` } }
    );
    expect(candidatePage.status).toBe(200);
    expect((await candidatePage.json()).data).toMatchObject({
      conductReportId: fixture.reportId,
      conversationType: 'CONVERSATION_CANDIDATE_INQUIRY',
      messages: [{ contentText: `Candidate Inquiry from ${reporterId}` }],
    });

    const unrelatedConversationRead = await adminRequest(
      `/api/v1/admin/evidence/${conversations.candidateConversationIds[2]}`,
      { headers: { 'idempotency-key': `conduct-unrelated-${fixture.reportId}` } }
    );
    expect(unrelatedConversationRead.status).toBe(404);

    await db
      .update(adminConductReportEvidenceHandle)
      .set({ conversationId: conversations.candidateConversationIds[2]! })
      .where(eq(adminConductReportEvidenceHandle.id, otherCandidateHandle.handle));
    const reassignedHandleRead = await adminRequest(
      `/api/v1/admin/evidence/${otherCandidateHandle.handle}`,
      { headers: { 'idempotency-key': `conduct-reassigned-${fixture.reportId}` } }
    );
    expect(reassignedHandleRead.status).toBe(404);
    await db
      .update(adminConductReportEvidenceHandle)
      .set({ conversationId: conversations.candidateConversationIds[1]! })
      .where(eq(adminConductReportEvidenceHandle.id, otherCandidateHandle.handle));

    const actions = await db
      .select({
        action: adminAction.action,
        metadata: adminAction.metadata,
        resultData: adminAction.resultData,
      })
      .from(adminAction)
      .where(eq(adminAction.resourceId, fixture.reportId));
    expect(
      actions.filter((action) => action.action === 'CONDUCT_REPORT_EVIDENCE_ACCESS')
    ).toHaveLength(4);
    expect(
      actions.filter((action) => action.action === 'CONDUCT_REPORT_EVIDENCE_FILE_ACCESS')
    ).toHaveLength(1);
    expect(JSON.stringify(actions)).not.toContain('Conduct Report history message');
    expect(JSON.stringify(actions)).not.toContain('https://storage.example');
    expect(JSON.stringify(actions)).not.toContain('conduct-report-fixture/');

    const directConversationRead = await adminRequest(
      `/api/v1/admin/evidence/${conversations.workConversationId}`,
      { headers: { 'idempotency-key': `conduct-direct-work-${fixture.reportId}` } }
    );
    expect(directConversationRead.status).toBe(404);
    const noWriteRoute = await adminRequest(`/api/v1/admin/evidence/${workHandle.handle}`, {
      method: 'POST',
      headers: { 'idempotency-key': `conduct-no-write-${fixture.reportId}` },
    });
    expect(noWriteRoute.status).toBe(404);
    expect(
      await db
        .select({ id: chatMembership.id })
        .from(chatMembership)
        .where(
          inArray(
            chatMembership.conversationId,
            conversations.candidateConversationIds.concat(conversations.workConversationId)
          )
        )
    ).toHaveLength(initialMemberships.length);

    const terminalAt = new Date('2020-02-03T10:00:00.000Z');
    await db
      .update(quest)
      .set({ questStatus: 'QUEST_FAILED', failedAt: terminalAt, updatedAt: terminalAt })
      .where(eq(quest.id, fixture.questId));
    await db
      .update(chatConversation)
      .set({
        questStatus: 'QUEST_FAILED',
        readOnlyAt: terminalAt,
        archivedAt: terminalAt,
        latestTerminalAt: terminalAt,
        updatedAt: terminalAt,
      })
      .where(eq(chatConversation.id, conversations.workConversationId));
    const expiredRead = await adminRequest(`/api/v1/admin/evidence/${workHandle.handle}`, {
      headers: { 'idempotency-key': `conduct-expired-${fixture.reportId}` },
    });
    expect(expiredRead.status).toBe(404);
    const expiredDetail = await adminRequest(`/api/v1/admin/reports/${fixture.reportId}`);
    expect((await expiredDetail.json()).data.evidenceHandles).toEqual([]);
  });

  it('walks the shared Report queue at limit 1 in both sort directions across microsecond rows', async () => {
    if (!postgresAvailable) return;
    const reportCaseEarly = await createReportFixture();
    const conductReportEarly = await createConductReportFixture({
      filerId: reporterId,
      reportedMemberId: senderId,
      assignmentWorkerId: reporterId,
    });
    const reportCaseLate = await createReportFixture();
    const conductReportLate = await createConductReportFixture({
      filerId: reporterId,
      reportedMemberId: senderId,
      assignmentWorkerId: reporterId,
    });
    const seeded = [
      {
        kind: 'REPORT_CASE' as const,
        id: reportCaseEarly.caseId,
        createdAt: '2035-04-01T00:00:00.100200Z',
      },
      {
        kind: 'CONDUCT_REPORT' as const,
        id: conductReportEarly.reportId,
        createdAt: '2035-04-01T00:00:00.100800Z',
      },
      {
        kind: 'REPORT_CASE' as const,
        id: reportCaseLate.caseId,
        createdAt: '2035-04-01T00:00:00.101300Z',
      },
      {
        kind: 'CONDUCT_REPORT' as const,
        id: conductReportLate.reportId,
        createdAt: '2035-04-01T00:00:00.101300Z',
      },
    ];

    for (const row of seeded) {
      // Raw SQL preserves microseconds that JavaScript Date would truncate.
      if (row.kind === 'REPORT_CASE') {
        // eslint-disable-next-line no-await-in-loop
        await sql`UPDATE admin_report_cases SET created_at = ${row.createdAt}::timestamptz WHERE id = ${row.id}`;
      } else {
        // eslint-disable-next-line no-await-in-loop
        await sql`UPDATE admin_conduct_reports SET created_at = ${row.createdAt}::timestamptz WHERE id = ${row.id}`;
      }
    }

    const readEveryPage = async (sort: 'newest' | 'oldest') => {
      const rows: Array<{ kind: 'REPORT_CASE' | 'CONDUCT_REPORT'; id: string }> = [];
      let cursor: string | null = null;
      for (let page = 0; page < 8; page += 1) {
        const params = new URLSearchParams({ limit: '1', sort, memberId: senderId });
        if (cursor) params.set('cursor', cursor);
        // Each cursor comes from the prior response, so these requests stay sequential.
        // eslint-disable-next-line no-await-in-loop
        const response = await adminRequest('/api/v1/admin/reports?' + params.toString());
        expect(response.status).toBe(200);
        // eslint-disable-next-line no-await-in-loop
        const body = await response.json();
        rows.push(
          ...body.data.items.map(
            (item: { kind: 'REPORT_CASE' | 'CONDUCT_REPORT'; id: string }) => ({
              kind: item.kind,
              id: item.id,
            })
          )
        );
        cursor = body.data.nextCursor;
        if (!cursor) break;
      }
      expect(cursor).toBeNull();
      return rows;
    };

    const timestampTiesAscending = [
      { kind: 'REPORT_CASE' as const, id: reportCaseLate.caseId },
      { kind: 'CONDUCT_REPORT' as const, id: conductReportLate.reportId },
    ].sort((left, right) => left.id.localeCompare(right.id));
    expect(await readEveryPage('oldest')).toEqual([
      { kind: 'REPORT_CASE', id: reportCaseEarly.caseId },
      { kind: 'CONDUCT_REPORT', id: conductReportEarly.reportId },
      ...timestampTiesAscending,
    ]);
    expect(await readEveryPage('newest')).toEqual([
      ...timestampTiesAscending.reverse(),
      { kind: 'CONDUCT_REPORT', id: conductReportEarly.reportId },
      { kind: 'REPORT_CASE', id: reportCaseEarly.caseId },
    ]);
  });

  it('dismisses a pending Conduct Report and replays the same Admin Action', async () => {
    if (!postgresAvailable) return;
    const fixture = await createConductReportFixture();
    const requestKey = `conduct-dismiss-${fixture.reportId}`;
    const [questBefore] = await db
      .select({
        questStatus: quest.questStatus,
        rewardSatang: quest.rewardSatang,
        questFundingTotalSatang: quest.questFundingTotalSatang,
        questEscrowSatang: quest.questEscrowSatang,
      })
      .from(quest)
      .where(eq(quest.id, fixture.questId));
    const [assignmentBefore] = await db
      .select({ assignmentStatus: questAssignment.assignmentStatus })
      .from(questAssignment)
      .where(eq(questAssignment.id, fixture.assignmentId));
    const body = {
      outcome: 'CONDUCT_REPORT_DISMISSED',
      decisionReasonCode: 'CONDUCT_REPORT_NO_VIOLATION',
    };

    const first = await adminRequest(`/api/v1/admin/reports/${fixture.reportId}/decide`, {
      method: 'POST',
      headers: { 'idempotency-key': requestKey, 'if-match': '1' },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.data.resourceSummary).toMatchObject({
      kind: 'CONDUCT_REPORT',
      id: fixture.reportId,
      status: 'CONDUCT_REPORT_DISMISSED',
      version: 2,
      resolvedAt: expect.any(String),
    });
    expect(firstBody.data.resourceSummary).not.toHaveProperty('decisionReasonText');

    const [report] = await db
      .select({
        status: adminConductReport.status,
        version: adminConductReport.version,
        decisionReason: adminConductReport.decisionReason,
        resolvedByAdminId: adminConductReport.resolvedByAdminId,
        resolvedAt: adminConductReport.resolvedAt,
      })
      .from(adminConductReport)
      .where(eq(adminConductReport.id, fixture.reportId));
    expect(report).toMatchObject({
      status: 'CONDUCT_REPORT_DISMISSED',
      version: 2,
      decisionReason: 'CONDUCT_REPORT_NO_VIOLATION',
      resolvedByAdminId: adminId,
      resolvedAt: expect.any(Date),
    });

    const [action] = await db
      .select()
      .from(adminAction)
      .where(eq(adminAction.id, firstBody.data.adminActionId));
    expect(action).toMatchObject({
      adminId,
      action: 'CONDUCT_REPORT_DISMISS',
      resourceType: 'conduct_report',
      resourceId: fixture.reportId,
      requestKey,
      reasonCatalogVersion: 1,
      reasonCode: 'CONDUCT_REPORT_NO_VIOLATION',
      expectedVersion: 1,
      resultVersion: 2,
      metadata: { outcome: 'CONDUCT_REPORT_DISMISSED' },
    });
    expect(action?.metadata).not.toHaveProperty('decisionReasonText');
    expect(action?.resultData).not.toHaveProperty('decisionReasonText');
    expect(action?.resultData).not.toHaveProperty('detail');
    expect(
      await db
        .select({
          questStatus: quest.questStatus,
          rewardSatang: quest.rewardSatang,
          questFundingTotalSatang: quest.questFundingTotalSatang,
          questEscrowSatang: quest.questEscrowSatang,
        })
        .from(quest)
        .where(eq(quest.id, fixture.questId))
    ).toEqual([questBefore]);
    expect(
      await db
        .select({ assignmentStatus: questAssignment.assignmentStatus })
        .from(questAssignment)
        .where(eq(questAssignment.id, fixture.assignmentId))
    ).toEqual([assignmentBefore]);

    const replay = await adminRequest(`/api/v1/admin/reports/${fixture.reportId}/decide`, {
      method: 'POST',
      headers: { 'idempotency-key': requestKey, 'if-match': '1' },
      body: JSON.stringify(body),
    });
    expect(replay.status).toBe(200);
    expect((await replay.json()).data.adminActionId).toBe(firstBody.data.adminActionId);
    expect(
      await db
        .select({ id: adminAction.id })
        .from(adminAction)
        .where(
          and(
            eq(adminAction.action, 'CONDUCT_REPORT_DISMISS'),
            eq(adminAction.resourceId, fixture.reportId)
          )
        )
    ).toHaveLength(1);
  });

  it('upholds a Conduct Report, records a Misconduct violation, and replays the Admin Action', async () => {
    if (!postgresAvailable) return;
    const fixture = await createConductReportFixture({ reason: conductReportReason.outOfScope });
    const path = `/api/v1/admin/reports/${fixture.reportId}/decide`;
    const body = { outcome: 'CONDUCT_REPORT_UPHELD' };
    const requestKey = `conduct-uphold-${fixture.reportId}`;

    const first = await adminRequest(path, {
      method: 'POST',
      headers: { 'idempotency-key': requestKey, 'if-match': '1' },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.data.resourceSummary).toMatchObject({
      kind: 'CONDUCT_REPORT',
      id: fixture.reportId,
      status: 'CONDUCT_REPORT_UPHELD',
      version: 2,
      resolvedAt: expect.any(String),
    });

    const [report] = await db
      .select({
        status: adminConductReport.status,
        version: adminConductReport.version,
        reason: adminConductReport.reason,
        decisionReason: adminConductReport.decisionReason,
        resolvedByAdminId: adminConductReport.resolvedByAdminId,
        resolvedAt: adminConductReport.resolvedAt,
      })
      .from(adminConductReport)
      .where(eq(adminConductReport.id, fixture.reportId));
    expect(report).toMatchObject({
      status: 'CONDUCT_REPORT_UPHELD',
      version: 2,
      reason: 'CONDUCT_OUT_OF_SCOPE',
      decisionReason: 'CONDUCT_OUT_OF_SCOPE',
      resolvedByAdminId: adminId,
      resolvedAt: expect.any(Date),
    });

    const [action] = await db
      .select()
      .from(adminAction)
      .where(eq(adminAction.id, firstBody.data.adminActionId));
    expect(action).toMatchObject({
      adminId,
      action: 'CONDUCT_REPORT_UPHOLD',
      resourceType: 'conduct_report',
      resourceId: fixture.reportId,
      requestKey,
      reasonCatalogVersion: 1,
      reasonCode: 'CONDUCT_OUT_OF_SCOPE',
      expectedVersion: 1,
      resultVersion: 2,
      metadata: { outcome: 'CONDUCT_REPORT_UPHELD' },
    });

    const penaltyRows = await db
      .select({
        ladder: memberPenaltyRecord.ladder,
        source: memberPenaltyRecord.source,
        sourceId: memberPenaltyRecord.sourceId,
        result: memberPenaltyRecord.result,
        actorType: memberPenaltyRecord.actorType,
        actorAdminId: memberPenaltyRecord.actorAdminId,
        reasonCode: memberPenaltyRecord.reasonCode,
      })
      .from(memberPenaltyRecord)
      .where(
        and(
          eq(memberPenaltyRecord.memberId, fixture.reportedMemberId),
          eq(memberPenaltyRecord.source, 'CONDUCT_REPORT'),
          eq(memberPenaltyRecord.sourceId, fixture.reportId)
        )
      );
    expect(penaltyRows).toEqual([
      {
        ladder: 'MISCONDUCT',
        source: 'CONDUCT_REPORT',
        sourceId: fixture.reportId,
        result: 'PENALTY_EXEMPT',
        actorType: 'ADMIN',
        actorAdminId: adminId,
        reasonCode: 'CONDUCT_OUT_OF_SCOPE',
      },
    ]);

    const [delivery] = await db
      .select()
      .from(pushDelivery)
      .where(
        and(
          eq(pushDelivery.recipientMemberId, fixture.reportedMemberId),
          eq(pushDelivery.eventKey, `conduct-report-upheld:${fixture.reportId}`)
        )
      );
    expect(delivery).toMatchObject({
      eventType: 'CONDUCT_REPORT_UPHELD',
      title: 'Conduct Report decision',
      status: 'PUSH_DELIVERY_PENDING',
      data: {
        eventType: 'CONDUCT_REPORT_UPHELD',
        reportId: fixture.reportId,
        reasonCode: 'CONDUCT_OUT_OF_SCOPE',
        decision: 'UPHELD',
        penaltyResult: 'PENALTY_EXEMPT',
      },
    });
    expect(delivery?.body).toBe(
      'Your Conduct Report was upheld for work outside the agreed scope. The result is no additional restriction.'
    );
    expect(delivery?.deepLink).toMatch(/^kuquest:\/\/conduct-reports\/CND-\d{6}$/);

    const replay = await adminRequest(path, {
      method: 'POST',
      headers: { 'idempotency-key': requestKey, 'if-match': '1' },
      body: JSON.stringify(body),
    });
    expect(replay.status).toBe(200);
    expect((await replay.json()).data.adminActionId).toBe(firstBody.data.adminActionId);
    expect(
      await db
        .select({ id: memberPenaltyRecord.id })
        .from(memberPenaltyRecord)
        .where(eq(memberPenaltyRecord.sourceId, fixture.reportId))
    ).toHaveLength(1);
    expect(
      await db
        .select({ id: pushDelivery.id })
        .from(pushDelivery)
        .where(eq(pushDelivery.eventKey, `conduct-report-upheld:${fixture.reportId}`))
    ).toHaveLength(1);

    const repeated = await adminRequest(path, {
      method: 'POST',
      headers: {
        'idempotency-key': `conduct-uphold-again-${fixture.reportId}`,
        'if-match': '2',
      },
      body: JSON.stringify(body),
    });
    expect(repeated.status).toBe(409);
    expect((await repeated.json()).error.code).toBe('CONDUCT_REPORT_OUTCOME_INVALID');
  });

  it('validates the Conduct Report dismissal catalog and keeps Admin-only access', async () => {
    if (!postgresAvailable) return;
    const fixture = await createConductReportFixture();
    const path = `/api/v1/admin/reports/${fixture.reportId}/decide`;

    const invalidCode = await adminRequest(path, {
      method: 'POST',
      headers: {
        'idempotency-key': `conduct-dismiss-invalid-${fixture.reportId}`,
        'if-match': '1',
      },
      body: JSON.stringify({
        outcome: 'CONDUCT_REPORT_DISMISSED',
        decisionReasonCode: 'POLICY_REVIEW',
      }),
    });
    expect(invalidCode.status).toBe(400);
    expect((await invalidCode.json()).error.code).toBe('VALIDATION');

    const freeFormText = await adminRequest(path, {
      method: 'POST',
      headers: { 'idempotency-key': `conduct-dismiss-text-${fixture.reportId}`, 'if-match': '1' },
      body: JSON.stringify({
        outcome: 'CONDUCT_REPORT_DISMISSED',
        decisionReasonCode: 'CONDUCT_REPORT_NO_VIOLATION',
        decisionReasonText: 'This free-form reason must not be accepted.',
      }),
    });
    expect(freeFormText.status).toBe(400);
    expect((await freeFormText.json()).error.code).toBe('VALIDATION');

    const anonymous = await app.handle(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'conduct-anonymous',
          'if-match': '1',
        },
        body: JSON.stringify({
          outcome: 'CONDUCT_REPORT_DISMISSED',
          decisionReasonCode: 'CONDUCT_REPORT_NO_VIOLATION',
        }),
      })
    );
    expect(anonymous.status).toBe(401);

    mock.restore();
    memberAuthentication(reporterId);
    const member = await app.handle(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'conduct-member',
          'if-match': '1',
        },
        body: JSON.stringify({
          outcome: 'CONDUCT_REPORT_DISMISSED',
          decisionReasonCode: 'CONDUCT_REPORT_NO_VIOLATION',
        }),
      })
    );
    expect(member.status).toBe(403);

    const [report] = await db
      .select({ status: adminConductReport.status, version: adminConductReport.version })
      .from(adminConductReport)
      .where(eq(adminConductReport.id, fixture.reportId));
    expect(report).toEqual({ status: 'CONDUCT_REPORT_PENDING', version: 1 });
    expect(
      await db
        .select({ id: adminAction.id })
        .from(adminAction)
        .where(eq(adminAction.resourceId, fixture.reportId))
    ).toHaveLength(0);
  });

  it('rejects stale versions and terminal Conduct Reports without a second decision', async () => {
    if (!postgresAvailable) return;
    const concurrentFixture = await createConductReportFixture();
    const concurrentPath = `/api/v1/admin/reports/${concurrentFixture.reportId}/decide`;
    const concurrentResponses = await Promise.all(
      ['a', 'b'].map((suffix) =>
        adminRequest(concurrentPath, {
          method: 'POST',
          headers: {
            'idempotency-key': `conduct-dismiss-${suffix}-${concurrentFixture.reportId}`,
            'if-match': '1',
          },
          body: JSON.stringify({
            outcome: 'CONDUCT_REPORT_DISMISSED',
            decisionReasonCode: 'CONDUCT_REPORT_INSUFFICIENT_EVIDENCE',
          }),
        })
      )
    );
    const concurrentBodies = await Promise.all(
      concurrentResponses.map((response) => response.json())
    );
    expect(concurrentResponses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(concurrentBodies.find((body) => body.error)?.error.code).toBe('ADMIN_ACTION_CONFLICT');

    const stale = await adminRequest(concurrentPath, {
      method: 'POST',
      headers: {
        'idempotency-key': `conduct-dismiss-stale-${concurrentFixture.reportId}`,
        'if-match': '1',
      },
      body: JSON.stringify({
        outcome: 'CONDUCT_REPORT_DISMISSED',
        decisionReasonCode: 'CONDUCT_REPORT_NO_VIOLATION',
      }),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe('ADMIN_ACTION_CONFLICT');
    expect(
      await db
        .select({ id: adminAction.id })
        .from(adminAction)
        .where(
          and(
            eq(adminAction.action, 'CONDUCT_REPORT_DISMISS'),
            eq(adminAction.resourceId, concurrentFixture.reportId)
          )
        )
    ).toHaveLength(1);

    const terminalFixture = await createConductReportFixture();
    const resolvedAt = new Date('2020-02-02T11:00:00.000Z');
    await db
      .update(adminConductReport)
      .set({
        status: 'CONDUCT_REPORT_DISMISSED',
        version: 2,
        decisionReason: 'CONDUCT_REPORT_NO_VIOLATION',
        resolvedByAdminId: adminId,
        resolvedAt,
        updatedAt: resolvedAt,
      })
      .where(eq(adminConductReport.id, terminalFixture.reportId));
    const terminal = await adminRequest(
      `/api/v1/admin/reports/${terminalFixture.reportId}/decide`,
      {
        method: 'POST',
        headers: {
          'idempotency-key': `conduct-dismiss-terminal-${terminalFixture.reportId}`,
          'if-match': '2',
        },
        body: JSON.stringify({
          outcome: 'CONDUCT_REPORT_DISMISSED',
          decisionReasonCode: 'CONDUCT_REPORT_NO_VIOLATION',
        }),
      }
    );
    expect(terminal.status).toBe(409);
    expect((await terminal.json()).error.code).toBe('CONDUCT_REPORT_OUTCOME_INVALID');
    expect(
      await db
        .select({ id: adminAction.id })
        .from(adminAction)
        .where(eq(adminAction.resourceId, terminalFixture.reportId))
    ).toHaveLength(0);
  });

  it('rolls back a Conduct Report dismissal when AdminAction persistence fails', async () => {
    if (!postgresAvailable) return;
    const fixture = await createConductReportFixture();
    await sql`CREATE OR REPLACE FUNCTION admin_report_test_fail_conduct_dismiss() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'CONDUCT_REPORT_DISMISS' THEN
          RAISE EXCEPTION 'forced Conduct Report AdminAction failure';
        END IF;
        RETURN NEW;
      END;
    $$`;
    await sql`CREATE TRIGGER admin_report_test_fail_conduct_dismiss_trigger
      BEFORE INSERT ON admin_action
      FOR EACH ROW EXECUTE FUNCTION admin_report_test_fail_conduct_dismiss()`;

    const expectedFailureLog = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await adminRequest(`/api/v1/admin/reports/${fixture.reportId}/decide`, {
        method: 'POST',
        headers: {
          'idempotency-key': `conduct-dismiss-atomic-${fixture.reportId}`,
          'if-match': '1',
        },
        body: JSON.stringify({
          outcome: 'CONDUCT_REPORT_DISMISSED',
          decisionReasonCode: 'CONDUCT_REPORT_NO_VIOLATION',
        }),
      });
      expect(response.status).toBe(500);

      const [report] = await db
        .select({
          status: adminConductReport.status,
          version: adminConductReport.version,
          decisionReason: adminConductReport.decisionReason,
          resolvedByAdminId: adminConductReport.resolvedByAdminId,
          resolvedAt: adminConductReport.resolvedAt,
        })
        .from(adminConductReport)
        .where(eq(adminConductReport.id, fixture.reportId));
      expect(report).toEqual({
        status: 'CONDUCT_REPORT_PENDING',
        version: 1,
        decisionReason: null,
        resolvedByAdminId: null,
        resolvedAt: null,
      });
      expect(
        await db
          .select({ id: adminAction.id })
          .from(adminAction)
          .where(eq(adminAction.resourceId, fixture.reportId))
      ).toHaveLength(0);
    } finally {
      expectedFailureLog.mockRestore();
      await sql`DROP TRIGGER IF EXISTS admin_report_test_fail_conduct_dismiss_trigger ON admin_action`;
      await sql`DROP FUNCTION IF EXISTS admin_report_test_fail_conduct_dismiss()`;
    }
  });

  it('rolls back a Conduct Report penalty when AdminAction persistence fails', async () => {
    if (!postgresAvailable) return;
    const fixture = await createConductReportFixture();
    await sql`CREATE OR REPLACE FUNCTION admin_report_test_fail_conduct_uphold() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'CONDUCT_REPORT_UPHOLD' THEN
          RAISE EXCEPTION 'forced Conduct Report AdminAction failure';
        END IF;
        RETURN NEW;
      END;
    $$`;
    await sql`CREATE TRIGGER admin_report_test_fail_conduct_uphold_trigger
      BEFORE INSERT ON admin_action
      FOR EACH ROW EXECUTE FUNCTION admin_report_test_fail_conduct_uphold()`;

    const expectedFailureLog = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await adminRequest(`/api/v1/admin/reports/${fixture.reportId}/decide`, {
        method: 'POST',
        headers: {
          'idempotency-key': `conduct-uphold-atomic-${fixture.reportId}`,
          'if-match': '1',
        },
        body: JSON.stringify({ outcome: 'CONDUCT_REPORT_UPHELD' }),
      });
      expect(response.status).toBe(500);

      const [report] = await db
        .select({
          status: adminConductReport.status,
          version: adminConductReport.version,
          decisionReason: adminConductReport.decisionReason,
          resolvedByAdminId: adminConductReport.resolvedByAdminId,
          resolvedAt: adminConductReport.resolvedAt,
        })
        .from(adminConductReport)
        .where(eq(adminConductReport.id, fixture.reportId));
      expect(report).toEqual({
        status: 'CONDUCT_REPORT_PENDING',
        version: 1,
        decisionReason: null,
        resolvedByAdminId: null,
        resolvedAt: null,
      });
      expect(
        await db
          .select({ id: memberPenaltyRecord.id })
          .from(memberPenaltyRecord)
          .where(eq(memberPenaltyRecord.sourceId, fixture.reportId))
      ).toHaveLength(0);
      expect(
        await db
          .select({ id: adminAction.id })
          .from(adminAction)
          .where(eq(adminAction.resourceId, fixture.reportId))
      ).toHaveLength(0);
    } finally {
      expectedFailureLog.mockRestore();
      await sql`DROP TRIGGER IF EXISTS admin_report_test_fail_conduct_uphold_trigger ON admin_action`;
      await sql`DROP FUNCTION IF EXISTS admin_report_test_fail_conduct_uphold()`;
    }
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

    const hiddenQueue = await adminRequest(
      `/api/v1/admin/reports?kind=REPORT_CASE&questId=${fixture.questId}`
    );
    expect(hiddenQueue.status).toBe(200);
    expect((await hiddenQueue.json()).data.items).toContainEqual(
      expect.objectContaining({
        id: fixture.caseId,
        kind: 'REPORT_CASE',
        status: 'REPORT_CASE_HIDDEN',
      })
    );

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
    expect(
      await db
        .select({ result: memberPenaltyRecord.result })
        .from(memberPenaltyRecord)
        .where(
          and(
            eq(memberPenaltyRecord.memberId, senderId),
            eq(memberPenaltyRecord.sourceId, fixture.caseId)
          )
        )
    ).toEqual([{ result: 'PENALTY_EXEMPT' }]);

    const rehide = await adminRequest(`/api/v1/admin/reports/${fixture.caseId}/decide`, {
      method: 'POST',
      headers: {
        'idempotency-key': `report-rehide-${fixture.caseId}`,
        'if-match': '2',
      },
      body: JSON.stringify({ outcome: 'REPORT_CASE_HIDDEN', reasonCode: 'POLICY_REVIEW' }),
    });
    expect(rehide.status).toBe(200);
    expect((await rehide.json()).data.resourceSummary).toMatchObject({
      status: 'REPORT_CASE_HIDDEN',
      version: 3,
    });
    expect(
      await db
        .select({ result: memberPenaltyRecord.result })
        .from(memberPenaltyRecord)
        .where(
          and(
            eq(memberPenaltyRecord.memberId, senderId),
            eq(memberPenaltyRecord.sourceId, fixture.caseId)
          )
        )
    ).toEqual([{ result: 'PENALTY_EXEMPT' }]);

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
        'if-match': '3',
      },
      body: JSON.stringify({ outcome: 'REPORT_CASE_RESTORED', reasonCode: 'POLICY_REVIEW' }),
    });
    expect(restore.status).toBe(200);
    expect((await restore.json()).data.resourceSummary).toMatchObject({
      status: 'REPORT_CASE_RESTORED',
      version: 4,
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
    ).toHaveLength(3);
    const penaltyRows = await db
      .select({
        result: memberPenaltyRecord.result,
        reversalOfRecordId: memberPenaltyRecord.reversalOfRecordId,
      })
      .from(memberPenaltyRecord)
      .where(
        and(
          eq(memberPenaltyRecord.memberId, senderId),
          eq(memberPenaltyRecord.sourceId, fixture.caseId)
        )
      );
    expect(penaltyRows).toHaveLength(2);
    expect(penaltyRows.map((row) => row.result)).toContain('PENALTY_EXEMPT');
    expect(
      penaltyRows.find((row) => row.result === 'PENALTY_REVERSAL')?.reversalOfRecordId
    ).toEqual(expect.any(String));
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

    const openQueue = await adminRequest(
      `/api/v1/admin/reports?kind=REPORT_CASE&questId=${fixture.questId}`
    );
    expect(openQueue.status).toBe(200);
    expect((await openQueue.json()).data.items).toEqual([]);

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
