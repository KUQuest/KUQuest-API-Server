import { app } from '@/app';
import { db, sql } from '@/database/client';
import {
  adminConductReport,
  adminReportCase,
  conductReportReason,
  conductReportStatus,
  type MemberPenaltyResult,
  reportCaseStatus,
} from '@/database/schema/admin.schema';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';
import { profileCertificate, profileWorkExperience } from '@/database/schema/profile.schema';
import { quest, questAssignment, review } from '@/database/schema/quest.schema';
import { chatConversation, chatMembership, chatMessage } from '@/database/schema/work-chat.schema';
import { tag } from '@/database/schema/tag.schema';
import { createAdminAuth } from '@/modules/auth/admin-auth.config';
import { createStudentAuth } from '@/modules/auth';
import { encodeCursor } from '@/shared/cursor';

import { Elysia } from 'elysia';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';

const adminEmail = `admin-member-profile-${crypto.randomUUID()}@example.com`;
const adminPassword = 'AdminMemberProfilePass1!';
const memberEmail = `admin-member-profile-${crypto.randomUUID()}@ku.th`;
const memberPassword = 'MemberProfilePass1!';
const targetMemberId = crypto.randomUUID();
const otherMemberId = crypto.randomUUID();
const emptyMemberId = crypto.randomUUID();
const workExperienceIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
const otherWorkExperienceId = crypto.randomUUID();
const certificateIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
const otherCertificateId = crypto.randomUUID();
const imageFileIds = [crypto.randomUUID(), crypto.randomUUID()];
const tagNames = Array.from(
  { length: 7 },
  (_, index) => `Admin profile Tag ${index} ${crypto.randomUUID()}`
);
const tagIds: string[] = [];
const questIds: string[] = [];
const penaltyHistoryMemberId = crypto.randomUUID();
const penaltyHistoryFilerId = crypto.randomUUID();
const penaltyHistoryAdditionalReviewerIds = [crypto.randomUUID(), crypto.randomUUID()];
const penaltyHistoryTagId = crypto.randomUUID();
const penaltyHistoryQuestId = crypto.randomUUID();
const penaltyHistoryAssignmentId = crypto.randomUUID();
const penaltyHistoryConversationId = crypto.randomUUID();
const penaltyHistoryMembershipId = crypto.randomUUID();
const penaltyHistoryMessageIds = Array.from({ length: 3 }, () => crypto.randomUUID());
const penaltyHistoryReportCaseIds = Array.from({ length: 3 }, () => crypto.randomUUID());
const penaltyHistoryConductReportId = crypto.randomUUID();
const penaltyHistoryReviewIds = Array.from({ length: 3 }, () => crypto.randomUUID());
const penaltyHistoryRecordIds = {
  exempt: crypto.randomUUID(),
  reversedOriginal: crypto.randomUUID(),
  activeConduct: crypto.randomUUID(),
  reviewFirst: crypto.randomUUID(),
  reviewSecond: crypto.randomUUID(),
  reversal: crypto.randomUUID(),
  beforeMemberCreated: crypto.randomUUID(),
  permanentReview: crypto.randomUUID(),
};
const penaltyHistoryReadPath = `/api/v1/admin/members/${penaltyHistoryMemberId}/penalty-history`;
type PenaltyHistorySeed = {
  id: string;
  memberId: string;
  ladder: 'MISCONDUCT' | 'REVIEW';
  source: 'REPORT_CASE' | 'CONDUCT_REPORT' | 'REVIEW_AVERAGE' | 'ADMIN';
  sourceId: string;
  sequenceNumber: number;
  result: MemberPenaltyResult;
  actorType: 'ADMIN' | 'SYSTEM';
  actorAdminId: string | null;
  reasonCode: string;
  createdAt: string;
  reversalOfRecordId: string | null;
};

const seedPenaltyHistoryRecord = async (record: PenaltyHistorySeed) =>
  sql`
    insert into member_penalty_records (
      id, member_id, ladder, source, source_id, sequence_number, result,
      actor_type, actor_admin_id, reason_code, created_at, reversal_of_record_id
    ) values (
      ${record.id}::uuid, ${record.memberId}::uuid, ${record.ladder}, ${record.source},
      ${record.sourceId}::uuid, ${record.sequenceNumber}, ${record.result},
      ${record.actorType}, ${record.actorAdminId}::uuid, ${record.reasonCode},
      ${record.createdAt}::timestamptz, ${record.reversalOfRecordId}::uuid
    )
  `;

const memberTestAuth = createStudentAuth({
  emailAndPasswordEnabled: true,
  allowEmailSignUp: true,
  autoSignIn: false,
  provisionWalletOnCreate: false,
});
const memberAuthApp = new Elysia({ name: 'admin-member-profile-member-auth' }).mount(
  memberTestAuth.handler
);

let adminId = '';
let memberAuthUserId = '';
let adminCookie = '';
let memberCookie = '';

const adminGet = (path: string, cookie = adminCookie) =>
  app.handle(new Request(`http://localhost${path}`, cookie ? { headers: { cookie } } : undefined));

const profileCollectionPaths = {
  tags: `/api/v1/admin/members/${targetMemberId}/profile-tags`,
  workExperiences: `/api/v1/admin/members/${targetMemberId}/work-experiences`,
  certificates: `/api/v1/admin/members/${targetMemberId}/certificates`,
  penaltyHistory: `/api/v1/admin/members/${targetMemberId}/penalty-history`,
};

const penaltyHistoryRecords = (): PenaltyHistorySeed[] => [
  {
    id: penaltyHistoryRecordIds.exempt,
    memberId: penaltyHistoryMemberId,
    ladder: 'MISCONDUCT',
    source: 'REPORT_CASE',
    sourceId: penaltyHistoryReportCaseIds[0]!,
    sequenceNumber: 1,
    result: 'PENALTY_EXEMPT',
    actorType: 'ADMIN',
    actorAdminId: adminId,
    reasonCode: 'TEST_EXEMPT',
    createdAt: '2030-08-05T00:00:00.100100Z',
    reversalOfRecordId: null,
  },
  {
    id: penaltyHistoryRecordIds.reversedOriginal,
    memberId: penaltyHistoryMemberId,
    ladder: 'MISCONDUCT',
    source: 'REPORT_CASE',
    sourceId: penaltyHistoryReportCaseIds[1]!,
    sequenceNumber: 2,
    result: 'PENALTY_RED_FLAG',
    actorType: 'ADMIN',
    actorAdminId: adminId,
    reasonCode: 'TEST_REVERSED',
    createdAt: '2030-08-05T00:00:00.100200Z',
    reversalOfRecordId: null,
  },
  {
    id: penaltyHistoryRecordIds.activeConduct,
    memberId: penaltyHistoryMemberId,
    ladder: 'MISCONDUCT',
    source: 'CONDUCT_REPORT',
    sourceId: penaltyHistoryConductReportId,
    sequenceNumber: 3,
    result: 'PENALTY_TEMPORARY_BAN_7_DAYS',
    actorType: 'ADMIN',
    actorAdminId: adminId,
    reasonCode: conductReportReason.abandoned,
    createdAt: '2030-08-05T00:00:00.100300Z',
    reversalOfRecordId: null,
  },
  {
    id: penaltyHistoryRecordIds.reviewFirst,
    memberId: penaltyHistoryMemberId,
    ladder: 'REVIEW',
    source: 'REVIEW_AVERAGE',
    sourceId: penaltyHistoryReviewIds[0]!,
    sequenceNumber: 1,
    result: 'PENALTY_TEMPORARY_BAN_7_DAYS',
    actorType: 'SYSTEM',
    actorAdminId: null,
    reasonCode: 'REVIEW_AVERAGE_LOW',
    createdAt: '2030-08-05T00:00:00.100400Z',
    reversalOfRecordId: null,
  },
  {
    id: penaltyHistoryRecordIds.reviewSecond,
    memberId: penaltyHistoryMemberId,
    ladder: 'REVIEW',
    source: 'REVIEW_AVERAGE',
    sourceId: penaltyHistoryReviewIds[1]!,
    sequenceNumber: 2,
    result: 'PENALTY_TEMPORARY_BAN_1_MONTH',
    actorType: 'SYSTEM',
    actorAdminId: null,
    reasonCode: 'REVIEW_AVERAGE_LOW',
    createdAt: '2030-08-05T00:00:00.100500Z',
    reversalOfRecordId: null,
  },
  {
    id: penaltyHistoryRecordIds.reversal,
    memberId: penaltyHistoryMemberId,
    ladder: 'MISCONDUCT',
    source: 'REPORT_CASE',
    sourceId: penaltyHistoryReportCaseIds[1]!,
    sequenceNumber: 2,
    result: 'PENALTY_REVERSAL',
    actorType: 'ADMIN',
    actorAdminId: adminId,
    reasonCode: 'REPORT_CASE_RESTORED',
    createdAt: '2030-08-05T00:00:00.100600Z',
    reversalOfRecordId: penaltyHistoryRecordIds.reversedOriginal,
  },
  {
    id: penaltyHistoryRecordIds.beforeMemberCreated,
    memberId: penaltyHistoryMemberId,
    ladder: 'MISCONDUCT',
    source: 'REPORT_CASE',
    sourceId: penaltyHistoryReportCaseIds[2]!,
    sequenceNumber: 4,
    result: 'PENALTY_RED_FLAG',
    actorType: 'ADMIN',
    actorAdminId: adminId,
    reasonCode: 'TEST_BEFORE_MEMBER_CREATED',
    createdAt: '2019-12-31T23:59:59.000000Z',
    reversalOfRecordId: null,
  },
];

beforeAll(async () => {
  await sql`select 1`;

  await db.insert(authUser).values([
    {
      id: targetMemberId,
      email: `${targetMemberId}@ku.th`,
      firstName: 'Target',
      lastName: 'Member',
    },
    {
      id: otherMemberId,
      email: `${otherMemberId}@ku.th`,
      firstName: 'Other',
      lastName: 'Member',
    },
    {
      id: emptyMemberId,
      email: `${emptyMemberId}@ku.th`,
      firstName: 'Empty',
      lastName: 'Member',
    },
  ]);

  const profileTags = await db
    .insert(tag)
    .values(tagNames.map((name) => ({ name })))
    .returning({ id: tag.id, name: tag.name });
  tagIds.push(...profileTags.map(({ id }) => id));
  const tagIdByName = Object.fromEntries(profileTags.map(({ id, name }) => [name, id]));
  const assignmentGroups: {
    tagIndex: number;
    count: number;
    questStatus: 'QUEST_COMPLETED' | 'QUEST_FAILED';
    assignmentStatus: 'ASSIGNMENT_COMPLETED' | 'ASSIGNMENT_INCOMPLETE';
    workerId: string;
  }[] = [
    {
      tagIndex: 0,
      count: 4,
      questStatus: 'QUEST_COMPLETED',
      assignmentStatus: 'ASSIGNMENT_COMPLETED',
      workerId: targetMemberId,
    },
    {
      tagIndex: 1,
      count: 3,
      questStatus: 'QUEST_COMPLETED',
      assignmentStatus: 'ASSIGNMENT_COMPLETED',
      workerId: targetMemberId,
    },
    {
      tagIndex: 2,
      count: 2,
      questStatus: 'QUEST_COMPLETED',
      assignmentStatus: 'ASSIGNMENT_COMPLETED',
      workerId: targetMemberId,
    },
    {
      tagIndex: 3,
      count: 1,
      questStatus: 'QUEST_COMPLETED',
      assignmentStatus: 'ASSIGNMENT_COMPLETED',
      workerId: targetMemberId,
    },
    {
      tagIndex: 4,
      count: 4,
      questStatus: 'QUEST_FAILED',
      assignmentStatus: 'ASSIGNMENT_COMPLETED',
      workerId: targetMemberId,
    },
    {
      tagIndex: 5,
      count: 4,
      questStatus: 'QUEST_COMPLETED',
      assignmentStatus: 'ASSIGNMENT_INCOMPLETE',
      workerId: targetMemberId,
    },
    {
      tagIndex: 6,
      count: 4,
      questStatus: 'QUEST_COMPLETED',
      assignmentStatus: 'ASSIGNMENT_COMPLETED',
      workerId: otherMemberId,
    },
  ];
  const questRows = assignmentGroups.flatMap((group) =>
    Array.from({ length: group.count }, () => {
      const id = crypto.randomUUID();
      return {
        id,
        workerId: group.workerId,
        assignmentStatus: group.assignmentStatus,
        quest: {
          id,
          hirerId: otherMemberId,
          title: `Admin profile Tag Quest ${crypto.randomUUID()}`,
          condition: 'Complete the test Quest',
          mode: 'NO_CANDIDATE' as const,
          participation: 'SOLO' as const,
          questStatus: group.questStatus,
          rewardSatang: 1_000,
          tagId: tagIdByName[tagNames[group.tagIndex]!]!,
          headcount: 1,
          startTime: new Date('2025-01-01T00:00:00.000Z'),
          dueAt: null,
          failedAt:
            group.questStatus === 'QUEST_FAILED' ? new Date('2025-01-02T00:00:00.000Z') : null,
        },
      };
    })
  );
  questIds.push(...questRows.map(({ id }) => id));
  await db.insert(quest).values(questRows.map(({ quest: questRow }) => questRow));
  await db.insert(questAssignment).values(
    questRows.map(({ id, workerId, assignmentStatus }) => ({
      questId: id,
      workerId,
      assignmentStatus,
    }))
  );

  const pageTimestamp = new Date('2025-05-05T00:00:00.000Z');
  await db.insert(profileWorkExperience).values([
    {
      id: workExperienceIds[0]!,
      userId: targetMemberId,
      title: 'Current Work Experience',
      employmentType: 'FULL_TIME',
      org: 'KUQuest Labs',
      description: 'Ongoing role',
      startedAt: '2022-01-01',
      endedAt: null,
      createdAt: pageTimestamp,
    },
    {
      id: workExperienceIds[1]!,
      userId: targetMemberId,
      title: 'Past Work Experience',
      employmentType: 'INTERNSHIP',
      org: null,
      description: null,
      startedAt: '2020-05-01',
      endedAt: '2021-04-30',
      createdAt: pageTimestamp,
    },
    {
      id: workExperienceIds[2]!,
      userId: targetMemberId,
      title: 'Other Work Experience',
      employmentType: 'PART_TIME',
      org: 'Other Org',
      description: 'Not owned by the target Member',
      startedAt: '2019-01-01',
      endedAt: '2019-12-31',
      createdAt: pageTimestamp,
    },
    {
      id: otherWorkExperienceId,
      userId: otherMemberId,
      title: 'Private Other Member Work Experience',
      employmentType: 'FULL_TIME',
      org: null,
      description: null,
      startedAt: '2018-01-01',
      endedAt: null,
      createdAt: pageTimestamp,
    },
  ]);

  await db.insert(file).values([
    {
      id: imageFileIds[0]!,
      bucket: 'private-certificate-bucket',
      objectKey: `private/certificate/${imageFileIds[0]}/storage-secret.png`,
      contentType: 'image/png',
      sizeBytes: 4096,
      uploadedByUserId: targetMemberId,
    },
    {
      id: imageFileIds[1]!,
      bucket: 'private-certificate-bucket',
      objectKey: `private/certificate/${imageFileIds[1]}/storage-secret.png`,
      contentType: 'image/png',
      sizeBytes: 4096,
      uploadedByUserId: targetMemberId,
      deletedAt: new Date(),
    },
  ]);
  await db.insert(profileCertificate).values([
    {
      id: certificateIds[0]!,
      userId: targetMemberId,
      name: 'Certificate with Image',
      issuer: 'KUQuest Institute',
      issuedAt: '2024-03-01',
      imageFileId: imageFileIds[0]!,
      createdAt: pageTimestamp,
    },
    {
      id: certificateIds[1]!,
      userId: targetMemberId,
      name: 'Certificate without Image',
      issuer: 'University of Kasetsart',
      issuedAt: '2023-02-01',
      imageFileId: null,
      createdAt: pageTimestamp,
    },
    {
      id: certificateIds[2]!,
      userId: targetMemberId,
      name: 'Certificate with Deleted Image',
      issuer: 'KU College',
      issuedAt: '2022-01-01',
      imageFileId: imageFileIds[1]!,
      createdAt: pageTimestamp,
    },
    {
      id: otherCertificateId,
      userId: otherMemberId,
      name: 'Private Other Member Certificate',
      issuer: 'Other issuer',
      issuedAt: '2024-03-01',
      imageFileId: null,
      createdAt: pageTimestamp,
    },
  ]);

  const memberSignUp = await memberTestAuth.api.signUpEmail({
    body: {
      email: memberEmail,
      password: memberPassword,
      name: 'Profile Member',
      firstName: 'Profile',
      lastName: 'Member',
    },
  });
  memberAuthUserId = memberSignUp.user.id;

  const adminAuth = createAdminAuth({
    allowSignUp: true,
    autoSignIn: false,
    markEmailVerified: true,
  });
  const signUp = await adminAuth.api.signUpEmail({
    body: {
      email: adminEmail,
      password: adminPassword,
      name: 'Profile Admin',
      firstName: 'Profile',
      lastName: 'Admin',
    },
  });
  adminId = signUp.user.id;

  const adminLogin = await app.handle(
    new Request('http://localhost/api/admin/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: adminPassword }),
    })
  );
  if (adminLogin.status !== 200) throw new Error('Profile Admin session was not created.');
  adminCookie = (adminLogin.headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');

  const memberLogin = await memberAuthApp.handle(
    new Request('http://localhost/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: memberEmail, password: memberPassword }),
    })
  );
  if (memberLogin.status !== 200) throw new Error('Profile Member session was not created.');
  memberCookie = (memberLogin.headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');
  const penaltySourceCreatedAt = new Date('2025-01-01T00:00:00.000Z');
  const penaltyMemberCreatedAt = new Date('2020-01-01T00:00:00.000Z');
  await db.insert(authUser).values([
    {
      id: penaltyHistoryMemberId,
      email: `${penaltyHistoryMemberId}@ku.th`,
      firstName: 'Penalty',
      lastName: 'History',
      createdAt: penaltyMemberCreatedAt,
    },
    {
      id: penaltyHistoryFilerId,
      email: `${penaltyHistoryFilerId}@ku.th`,
      firstName: 'History',
      lastName: 'Filer',
    },
    ...penaltyHistoryAdditionalReviewerIds.map((id) => ({
      id,
      email: `${id}@ku.th`,
      firstName: 'History',
      lastName: 'Reviewer',
    })),
  ]);
  await db.insert(tag).values({
    id: penaltyHistoryTagId,
    name: `Penalty history ${penaltyHistoryTagId}`,
  });
  await db.insert(quest).values({
    id: penaltyHistoryQuestId,
    hirerId: penaltyHistoryFilerId,
    title: 'Penalty history source Quest',
    condition: 'Complete the source Quest',
    mode: 'NO_CANDIDATE',
    participation: 'SOLO',
    questStatus: 'QUEST_ASSIGNED',
    rewardSatang: 1_000,
    tagId: penaltyHistoryTagId,
    startTime: penaltySourceCreatedAt,
    createdAt: penaltySourceCreatedAt,
    updatedAt: penaltySourceCreatedAt,
  });
  await db.insert(questAssignment).values({
    id: penaltyHistoryAssignmentId,
    questId: penaltyHistoryQuestId,
    workerId: penaltyHistoryMemberId,
    assignmentStatus: 'ASSIGNMENT_ACTIVE',
    createdAt: penaltySourceCreatedAt,
  });
  await db.insert(chatConversation).values({
    id: penaltyHistoryConversationId,
    questId: penaltyHistoryQuestId,
    type: 'CONVERSATION_WORK',
    questTitle: 'Penalty history source Quest',
    questStatus: 'QUEST_ASSIGNED',
    nextSequence: 4,
    createdAt: penaltySourceCreatedAt,
    updatedAt: penaltySourceCreatedAt,
  });
  await db.insert(chatMembership).values({
    id: penaltyHistoryMembershipId,
    conversationId: penaltyHistoryConversationId,
    assignmentId: penaltyHistoryAssignmentId,
    memberId: penaltyHistoryMemberId,
    role: 'WORKER',
    joinedAt: penaltySourceCreatedAt,
    createdAt: penaltySourceCreatedAt,
  });
  await db.insert(chatMessage).values(
    penaltyHistoryMessageIds.map((id, index) => ({
      id,
      conversationId: penaltyHistoryConversationId,
      sequence: index + 1,
      kind: 'USER' as const,
      senderMembershipId: penaltyHistoryMembershipId,
      clientMessageId: `penalty-history-${id}`,
      contentText: `Penalty history source Message ${index + 1}`,
      createdAt: penaltySourceCreatedAt,
    }))
  );
  await db.insert(adminReportCase).values(
    penaltyHistoryReportCaseIds.map((id, index) => ({
      id,
      messageId: penaltyHistoryMessageIds[index]!,
      status: reportCaseStatus.hidden,
      createdAt: penaltySourceCreatedAt,
      updatedAt: penaltySourceCreatedAt,
    }))
  );
  await db.insert(adminConductReport).values({
    id: penaltyHistoryConductReportId,
    questId: penaltyHistoryQuestId,
    filerUserId: penaltyHistoryFilerId,
    reportedMemberId: penaltyHistoryMemberId,
    assignmentId: penaltyHistoryAssignmentId,
    reason: conductReportReason.abandoned,
    status: conductReportStatus.upheld,
    decisionReason: conductReportReason.abandoned,
    resolvedByAdminId: adminId,
    resolvedAt: penaltySourceCreatedAt,
    createdAt: penaltySourceCreatedAt,
    updatedAt: penaltySourceCreatedAt,
  });
  await db.insert(review).values(
    penaltyHistoryReviewIds.map((id, index) => ({
      id,
      questId: penaltyHistoryQuestId,
      reviewerId:
        index === 0 ? penaltyHistoryFilerId : penaltyHistoryAdditionalReviewerIds[index - 1]!,
      revieweeId: penaltyHistoryMemberId,
      rating: index + 1,
      createdAt: penaltySourceCreatedAt,
      updatedAt: penaltySourceCreatedAt,
    }))
  );

  for (const record of penaltyHistoryRecords()) {
    // eslint-disable-next-line no-await-in-loop
    await seedPenaltyHistoryRecord(record);
  }
});

afterAll(async () => {
  await db
    .delete(profileCertificate)
    .where(inArray(profileCertificate.id, [...certificateIds, otherCertificateId]));
  await db
    .delete(profileWorkExperience)
    .where(inArray(profileWorkExperience.id, [...workExperienceIds, otherWorkExperienceId]));
  await db.delete(file).where(inArray(file.id, imageFileIds));
  await db.delete(questAssignment).where(inArray(questAssignment.questId, questIds));
  await db.delete(quest).where(inArray(quest.id, questIds));
  await db.delete(tag).where(inArray(tag.id, tagIds));
  await db
    .delete(authUser)
    .where(inArray(authUser.id, [targetMemberId, otherMemberId, emptyMemberId]));
  if (adminId) {
    await db.update(authAdmin).set({ disabledAt: new Date() }).where(eq(authAdmin.id, adminId));
  }
  if (memberAuthUserId) {
    await db.delete(authUser).where(eq(authUser.id, memberAuthUserId));
  }
});

type ErrorBody = { success: false; error: { code: string; message: string } };
type MemberIdentity = { displayId: string };
type ProfileTagBody = {
  success: true;
  data: { member: MemberIdentity; tags: Array<{ name: string }> };
};
type CollectionBody<T> = {
  success: true;
  data: {
    member: MemberIdentity;
    items: T[];
    totalCount: number;
    nextCursor: string | null;
  };
};
type WorkExperienceItem = {
  title: string;
  employmentType: string;
  organization: string | null;
  description: string | null;
  startedAt: string;
  endedAt: string | null;
};
type CertificateItem = {
  name: string;
  issuer: string;
  issuedAt: string;
  image: { contentType: string; sizeBytes: number } | null;
};

type PenaltyHistoryItem = {
  recordId: string;
  ladder: 'MISCONDUCT' | 'REVIEW';
  source: 'REPORT_CASE' | 'CONDUCT_REPORT' | 'REVIEW_AVERAGE';
  sourceDisplayId: string | null;
  sequenceNumber: number;
  result: MemberPenaltyResult;
  actor: { type: 'ADMIN' | 'SYSTEM'; displayName: string | null };
  reasonCode: string;
  adminNote: string | null;
  createdAt: string;
  reviewRating: number | null;
  isEffective: boolean;
  isEffectiveActiveMisconductPenalty: boolean;
  reversal: {
    relation: 'REVERSAL_OF' | 'REVERSED_BY';
    sequenceNumber: number;
    result: MemberPenaltyResult;
    createdAt: string;
  } | null;
  recalculatedFrom: {
    sequenceNumber: number;
    result: MemberPenaltyResult;
    createdAt: string;
  } | null;
  replacedBy: {
    sequenceNumber: number;
    result: MemberPenaltyResult;
    createdAt: string;
  } | null;
};
type PenaltyHistoryBody = {
  success: true;
  data: {
    member: MemberIdentity;
    confirmedMisconductCount: number;
    effectiveActiveMisconductPenaltyCount: number;
    reviewLadderRecordCount: number;
    versionToken: number;
    items: PenaltyHistoryItem[];
    totalCount: number;
    nextCursor: string | null;
  };
};

describe('Admin Member Profile collection reads', () => {
  it('publishes the guarded collection paths and response error contracts in OpenAPI', async () => {
    const response = await app.handle(new Request('http://localhost/openapi/json'));
    type OpenApiSchema = {
      properties?: Record<string, OpenApiSchema>;
      items?: OpenApiSchema;
    };
    type OpenApiResponse = {
      content?: Record<string, { schema?: OpenApiSchema }>;
    };
    type OpenApiOperation = {
      operationId?: string;
      parameters?: Array<{ in?: string; name?: string }>;
      security?: unknown[];
      responses?: Record<string, OpenApiResponse>;
    };
    const document = (await response.json()) as {
      paths: Record<string, { get?: OpenApiOperation }>;
    };

    expect(response.status).toBe(200);
    for (const path of [
      '/api/v1/admin/members/{id}/profile-tags',
      '/api/v1/admin/members/{id}/work-experiences',
      '/api/v1/admin/members/{id}/certificates',
      '/api/v1/admin/members/{id}/penalty-history',
    ]) {
      const operation = document.paths[path]?.get;
      expect(operation).toBeDefined();
      expect(operation?.security?.length).toBeGreaterThan(0);
      expect(Object.keys(operation?.responses ?? {})).toEqual(
        expect.arrayContaining(['200', '400', '401', '403', '404', '500'])
      );
    }

    const penaltyHistory = document.paths['/api/v1/admin/members/{id}/penalty-history']?.get;
    expect(penaltyHistory?.operationId).toBe('listAdminMemberPenaltyHistory');
    expect(
      penaltyHistory?.parameters
        ?.filter((parameter) => parameter.in === 'query')
        .map((parameter) => parameter.name)
    ).toEqual(expect.arrayContaining(['limit', 'cursor']));
    const dataProperties =
      penaltyHistory?.responses?.['200']?.content?.['application/json']?.schema?.properties?.data
        ?.properties;
    expect(Object.keys(dataProperties ?? {}).sort()).toEqual([
      'confirmedMisconductCount',
      'effectiveActiveMisconductPenaltyCount',
      'items',
      'member',
      'nextCursor',
      'reviewLadderRecordCount',
      'totalCount',
      'versionToken',
    ]);
    const itemProperties = dataProperties?.items?.items?.properties;
    expect(Object.keys(itemProperties ?? {}).sort()).toEqual([
      'actor',
      'adminNote',
      'createdAt',
      'isEffective',
      'isEffectiveActiveMisconductPenalty',
      'ladder',
      'reasonCode',
      'recalculatedFrom',
      'recordId',
      'replacedBy',
      'result',
      'reversal',
      'reviewRating',
      'sequenceNumber',
      'source',
      'sourceDisplayId',
    ]);
  });

  it('requires an enabled Admin Session and rejects anonymous and Member Sessions', async () => {
    for (const path of Object.values(profileCollectionPaths)) {
      // eslint-disable-next-line no-await-in-loop
      const anonymous = await adminGet(path, '');
      expect(anonymous.status).toBe(401);

      // eslint-disable-next-line no-await-in-loop
      const member = await adminGet(path, memberCookie);
      expect([401, 403]).toContain(member.status);

      // eslint-disable-next-line no-await-in-loop
      const admin = await adminGet(path);
      expect(admin.status).toBe(200);
    }

    await db.update(authAdmin).set({ disabledAt: new Date() }).where(eq(authAdmin.id, adminId));
    try {
      for (const path of Object.values(profileCollectionPaths)) {
        // eslint-disable-next-line no-await-in-loop
        const disabledAdmin = await adminGet(path);
        expect(disabledAdmin.status).toBe(403);
      }
    } finally {
      await db.update(authAdmin).set({ disabledAt: null }).where(eq(authAdmin.id, adminId));
    }
  });

  it('returns immutable penalty history and separates confirmed and effective ladder counts', async () => {
    const initialHistory = penaltyHistoryRecords();
    const pages: PenaltyHistoryBody[] = [];
    const items: PenaltyHistoryItem[] = [];
    let cursor: string | null = null;

    for (let pageNumber = 0; pageNumber < initialHistory.length + 1; pageNumber += 1) {
      const query = new URLSearchParams({ limit: '1' });
      if (cursor) query.set('cursor', cursor);
      // Each page cursor comes from the previous response, so these requests
      // must remain sequential.
      // eslint-disable-next-line no-await-in-loop
      const response = await adminGet(`${penaltyHistoryReadPath}?${query}`);
      expect(response.status).toBe(200);
      // eslint-disable-next-line no-await-in-loop
      const body = (await response.json()) as PenaltyHistoryBody;
      expect(body.data.member.displayId).toMatch(/^MEM-[0-9]{6,}$/);
      expect(body.data.confirmedMisconductCount).toBe(3);
      expect(body.data.effectiveActiveMisconductPenaltyCount).toBe(1);
      expect(body.data.reviewLadderRecordCount).toBe(2);
      expect(body.data.totalCount).toBe(7);
      expect(body.data.items).toHaveLength(1);
      pages.push(body);
      items.push(...body.data.items);
      cursor = body.data.nextCursor;
      if (!cursor) break;
    }

    const expectedRecordOrder = [...initialHistory]
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
      )
      .map(({ ladder, sequenceNumber, result }) => `${ladder}:${sequenceNumber}:${result}`);
    expect(cursor).toBeNull();
    expect(
      items.map(({ ladder, sequenceNumber, result }) => `${ladder}:${sequenceNumber}:${result}`)
    ).toEqual(expectedRecordOrder);

    const exempt = items.find(({ reasonCode }) => reasonCode === 'TEST_EXEMPT');
    expect(exempt).toMatchObject({
      ladder: 'MISCONDUCT',
      source: 'REPORT_CASE',
      sourceDisplayId: expect.stringMatching(/^RPT-[0-9]{6,}$/),
      sequenceNumber: 1,
      result: 'PENALTY_EXEMPT',
      actor: { type: 'ADMIN', displayName: 'Profile Admin' },
      isEffectiveActiveMisconductPenalty: false,
      reversal: null,
    });
    expect(Object.keys(exempt ?? {}).sort()).toEqual([
      'actor',
      'adminNote',
      'createdAt',
      'isEffective',
      'isEffectiveActiveMisconductPenalty',
      'ladder',
      'reasonCode',
      'recalculatedFrom',
      'recordId',
      'replacedBy',
      'result',
      'reversal',
      'reviewRating',
      'sequenceNumber',
      'source',
      'sourceDisplayId',
    ]);
    const reversedOriginal = items.find(({ reasonCode }) => reasonCode === 'TEST_REVERSED');
    expect(reversedOriginal).toMatchObject({
      result: 'PENALTY_RED_FLAG',
      isEffectiveActiveMisconductPenalty: false,
      reversal: {
        relation: 'REVERSED_BY',
        sequenceNumber: 2,
        result: 'PENALTY_REVERSAL',
        createdAt: expect.any(String),
      },
    });
    const reversal = items.find(({ result }) => result === 'PENALTY_REVERSAL');
    expect(reversal).toMatchObject({
      reversal: {
        relation: 'REVERSAL_OF',
        sequenceNumber: 2,
        result: 'PENALTY_RED_FLAG',
        createdAt: expect.any(String),
      },
    });
    const activeConduct = items.find(
      ({ reasonCode }) => reasonCode === conductReportReason.abandoned
    );
    expect(activeConduct).toMatchObject({
      source: 'CONDUCT_REPORT',
      sourceDisplayId: expect.stringMatching(/^CND-[0-9]{6,}$/),
      isEffectiveActiveMisconductPenalty: true,
      reversal: null,
    });
    const reviewFirst = items.find(
      ({ ladder, sequenceNumber }) => ladder === 'REVIEW' && sequenceNumber === 1
    );
    expect(reviewFirst).toMatchObject({
      ladder: 'REVIEW',
      source: 'REVIEW_AVERAGE',
      sourceDisplayId: expect.stringMatching(/^QST-[0-9]{6,}$/),
      reviewRating: 1,
      isEffectiveActiveMisconductPenalty: false,
      actor: { type: 'SYSTEM', displayName: 'System' },
    });
    // Penalty record UUIDs are returned so the Admin can target a record for Remove.
    const privateIdentifiers = [
      penaltyHistoryMemberId,
      penaltyHistoryFilerId,
      ...penaltyHistoryAdditionalReviewerIds,
      penaltyHistoryTagId,
      penaltyHistoryQuestId,
      penaltyHistoryAssignmentId,
      penaltyHistoryConversationId,
      penaltyHistoryMembershipId,
      ...penaltyHistoryMessageIds,
      ...penaltyHistoryReportCaseIds,
      penaltyHistoryConductReportId,
      ...penaltyHistoryReviewIds,
      adminId,
    ];
    const serializedPages = JSON.stringify(pages);
    for (const privateId of privateIdentifiers) {
      expect(serializedPages).not.toContain(privateId);
    }

    const readMemberStatusAndCounts = async (
      memberStatus: 'NORMAL' | 'RED_FLAG' | 'TEMPORARY_BAN'
    ) => {
      const detailResponse = await adminGet(`/api/v1/admin/members/${penaltyHistoryMemberId}`);
      expect(detailResponse.status).toBe(200);
      const detail = (await detailResponse.json()) as {
        data: { member: { memberStatus: string } };
      };
      expect(detail.data.member.memberStatus).toBe(memberStatus);

      const historyResponse = await adminGet(`${penaltyHistoryReadPath}?limit=1`);
      expect(historyResponse.status).toBe(200);
      const history = (await historyResponse.json()) as PenaltyHistoryBody;
      expect(history.data).toMatchObject({
        confirmedMisconductCount: 3,
        effectiveActiveMisconductPenaltyCount: 1,
        reviewLadderRecordCount: 2,
        totalCount: 7,
      });
    };

    await readMemberStatusAndCounts('NORMAL');
    await db
      .update(authUser)
      .set({ bannedUntil: null, redFlagExpiresAt: new Date(Date.now() + 86_400_000) })
      .where(eq(authUser.id, penaltyHistoryMemberId));
    await readMemberStatusAndCounts('RED_FLAG');
    await db
      .update(authUser)
      .set({ bannedUntil: new Date(Date.now() + 86_400_000), redFlagExpiresAt: null })
      .where(eq(authUser.id, penaltyHistoryMemberId));
    await readMemberStatusAndCounts('TEMPORARY_BAN');

    await seedPenaltyHistoryRecord({
      id: penaltyHistoryRecordIds.permanentReview,
      memberId: penaltyHistoryMemberId,
      ladder: 'REVIEW',
      source: 'REVIEW_AVERAGE',
      sourceId: penaltyHistoryReviewIds[2]!,
      sequenceNumber: 3,
      result: 'PENALTY_PERMANENT_BAN',
      actorType: 'SYSTEM',
      actorAdminId: null,
      reasonCode: 'REVIEW_AVERAGE_LOW',
      createdAt: '2030-08-05T00:00:00.100700Z',
      reversalOfRecordId: null,
    });
    await db
      .update(authUser)
      .set({ bannedUntil: null, redFlagExpiresAt: null })
      .where(eq(authUser.id, penaltyHistoryMemberId));

    const permanentMemberResponse = await adminGet(
      `/api/v1/admin/members/${penaltyHistoryMemberId}`
    );
    expect(permanentMemberResponse.status).toBe(200);
    const permanentMember = (await permanentMemberResponse.json()) as {
      data: { member: { memberStatus: string } };
    };
    expect(permanentMember.data.member.memberStatus).toBe('PERMANENT_BAN');

    const permanentHistoryResponse = await adminGet(`${penaltyHistoryReadPath}?limit=1`);
    expect(permanentHistoryResponse.status).toBe(200);
    const permanentHistory = (await permanentHistoryResponse.json()) as PenaltyHistoryBody;
    expect(permanentHistory.data).toMatchObject({
      confirmedMisconductCount: 3,
      effectiveActiveMisconductPenaltyCount: 1,
      reviewLadderRecordCount: 3,
      totalCount: 8,
    });
  });

  it('returns only the three most frequent completed Worker Quest Tags', async () => {
    const response = await adminGet(profileCollectionPaths.tags);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ProfileTagBody;

    expect(body.data.member.displayId).toMatch(/^MEM-[0-9]{6,}$/);
    expect(body.data.tags.map(({ name }) => name)).toEqual(tagNames.slice(0, 3));
    expect(body.data.tags).toHaveLength(3);
    expect(JSON.stringify(body)).not.toContain(targetMemberId);
    expect(JSON.stringify(body)).not.toContain(otherMemberId);
  });

  it('returns Work Experience pages with an authoritative total and preserves ongoing dates', async () => {
    const items: WorkExperienceItem[] = [];
    let cursor: string | null = null;
    let totalCount = 0;
    let displayId = '';

    for (let pageNumber = 0; pageNumber < 3; pageNumber += 1) {
      const query = new URLSearchParams({ limit: '1' });
      if (cursor) query.set('cursor', cursor);
      // eslint-disable-next-line no-await-in-loop
      const response = await adminGet(`${profileCollectionPaths.workExperiences}?${query}`);
      expect(response.status).toBe(200);
      // eslint-disable-next-line no-await-in-loop
      const body = (await response.json()) as CollectionBody<WorkExperienceItem>;
      expect(body.data.member.displayId).toMatch(/^MEM-[0-9]{6,}$/);
      expect(body.data.totalCount).toBe(3);
      expect(JSON.stringify(body)).not.toContain(targetMemberId);
      expect(JSON.stringify(body)).not.toContain(otherMemberId);
      displayId = body.data.member.displayId;
      totalCount = body.data.totalCount;
      expect(body.data.items).toHaveLength(1);
      items.push(...body.data.items);
      cursor = body.data.nextCursor;
    }

    expect(displayId).toMatch(/^MEM-[0-9]{6,}$/);
    expect(totalCount).toBe(3);
    expect(cursor).toBeNull();
    expect(items.map(({ title }) => title).sort()).toEqual(
      ['Current Work Experience', 'Past Work Experience', 'Other Work Experience'].sort()
    );
    expect(items).toContainEqual({
      title: 'Current Work Experience',
      employmentType: 'FULL_TIME',
      organization: 'KUQuest Labs',
      description: 'Ongoing role',
      startedAt: '2022-01-01',
      endedAt: null,
    });
    expect(items).toContainEqual({
      title: 'Past Work Experience',
      employmentType: 'INTERNSHIP',
      organization: null,
      description: null,
      startedAt: '2020-05-01',
      endedAt: '2021-04-30',
    });
    expect(JSON.stringify(items)).not.toContain(targetMemberId);
    expect(JSON.stringify(items)).not.toContain(otherMemberId);
    expect(JSON.stringify(items)).not.toContain('Private Other Member');
  });

  it('returns Certificate pages without storage locations or deleted image data', async () => {
    const items: CertificateItem[] = [];
    let cursor: string | null = null;
    let totalCount = 0;
    let displayId = '';

    for (let pageNumber = 0; pageNumber < 3; pageNumber += 1) {
      const query = new URLSearchParams({ limit: '1' });
      if (cursor) query.set('cursor', cursor);
      // eslint-disable-next-line no-await-in-loop
      const response = await adminGet(`${profileCollectionPaths.certificates}?${query}`);
      expect(response.status).toBe(200);
      // eslint-disable-next-line no-await-in-loop
      const body = (await response.json()) as CollectionBody<CertificateItem>;
      expect(body.data.member.displayId).toMatch(/^MEM-[0-9]{6,}$/);
      expect(body.data.totalCount).toBe(3);
      expect(JSON.stringify(body)).not.toContain(targetMemberId);
      expect(JSON.stringify(body)).not.toContain(otherMemberId);
      displayId = body.data.member.displayId;
      totalCount = body.data.totalCount;
      expect(body.data.items).toHaveLength(1);
      items.push(...body.data.items);
      cursor = body.data.nextCursor;
    }

    expect(displayId).toMatch(/^MEM-[0-9]{6,}$/);
    expect(totalCount).toBe(3);
    expect(cursor).toBeNull();
    expect(items.map(({ name }) => name).sort()).toEqual(
      [
        'Certificate with Image',
        'Certificate without Image',
        'Certificate with Deleted Image',
      ].sort()
    );
    expect(items).toContainEqual({
      name: 'Certificate with Image',
      issuer: 'KUQuest Institute',
      issuedAt: '2024-03-01',
      image: { contentType: 'image/png', sizeBytes: 4096 },
    });
    expect(items).toContainEqual({
      name: 'Certificate without Image',
      issuer: 'University of Kasetsart',
      issuedAt: '2023-02-01',
      image: null,
    });
    expect(items).toContainEqual({
      name: 'Certificate with Deleted Image',
      issuer: 'KU College',
      issuedAt: '2022-01-01',
      image: null,
    });
    const serialized = JSON.stringify(items);
    expect(serialized).not.toContain('private-certificate-bucket');
    expect(serialized).not.toContain('storage-secret.png');
    expect(serialized).not.toContain('https://');
    expect(serialized).not.toContain(targetMemberId);
    expect(serialized).not.toContain(otherMemberId);
    expect(serialized).not.toContain('Private Other Member');
  });
  it('rejects Work Experience, Certificate, and Penalty History cursors from another Member', async () => {
    const experienceFirstPageResponse = await adminGet(
      `${profileCollectionPaths.workExperiences}?limit=1`
    );
    expect(experienceFirstPageResponse.status).toBe(200);
    const experienceFirstPage =
      (await experienceFirstPageResponse.json()) as CollectionBody<WorkExperienceItem>;
    const experienceCursor = experienceFirstPage.data.nextCursor;
    if (!experienceCursor) throw new Error('The Work Experience fixture needs another page.');

    const crossMemberExperienceQuery = new URLSearchParams({ cursor: experienceCursor });
    const crossMemberExperience = await adminGet(
      `/api/v1/admin/members/${otherMemberId}/work-experiences?${crossMemberExperienceQuery}`
    );
    expect(crossMemberExperience.status).toBe(400);
    expect(((await crossMemberExperience.json()) as ErrorBody).error.code).toBe('INVALID_CURSOR');

    const certificateFirstPageResponse = await adminGet(
      `${profileCollectionPaths.certificates}?limit=1`
    );
    expect(certificateFirstPageResponse.status).toBe(200);
    const certificateFirstPage =
      (await certificateFirstPageResponse.json()) as CollectionBody<CertificateItem>;
    const certificateCursor = certificateFirstPage.data.nextCursor;
    if (!certificateCursor) throw new Error('The Certificate fixture needs another page.');

    const crossMemberCertificateQuery = new URLSearchParams({ cursor: certificateCursor });
    const crossMemberCertificate = await adminGet(
      `/api/v1/admin/members/${otherMemberId}/certificates?${crossMemberCertificateQuery}`
    );
    expect(crossMemberCertificate.status).toBe(400);
    expect(((await crossMemberCertificate.json()) as ErrorBody).error.code).toBe('INVALID_CURSOR');

    const penaltyFirstPageResponse = await adminGet(`${penaltyHistoryReadPath}?limit=1`);
    expect(penaltyFirstPageResponse.status).toBe(200);
    const penaltyFirstPage = (await penaltyFirstPageResponse.json()) as PenaltyHistoryBody;
    const penaltyCursor = penaltyFirstPage.data.nextCursor;
    if (!penaltyCursor) throw new Error('The Penalty History fixture needs another page.');

    const crossMemberPenaltyQuery = new URLSearchParams({ cursor: penaltyCursor });
    const crossMemberPenalty = await adminGet(
      `${profileCollectionPaths.penaltyHistory}?${crossMemberPenaltyQuery}`
    );
    expect(crossMemberPenalty.status).toBe(400);
    expect(((await crossMemberPenalty.json()) as ErrorBody).error.code).toBe('INVALID_CURSOR');
  });

  it('returns successful empty collections and errors for missing Members or invalid cursors', async () => {
    const tagsResponse = await adminGet(`/api/v1/admin/members/${emptyMemberId}/profile-tags`);
    expect(tagsResponse.status).toBe(200);
    const tagsBody = (await tagsResponse.json()) as ProfileTagBody;
    expect(tagsBody.data.tags).toEqual([]);

    for (const resource of ['work-experiences', 'certificates', 'penalty-history']) {
      const path = `/api/v1/admin/members/${emptyMemberId}/${resource}`;
      // eslint-disable-next-line no-await-in-loop
      const emptyResponse = await adminGet(path);
      expect(emptyResponse.status).toBe(200);
      // eslint-disable-next-line no-await-in-loop
      const emptyBody = (await emptyResponse.json()) as CollectionBody<unknown> & {
        data: {
          confirmedMisconductCount?: number;
          effectiveActiveMisconductPenaltyCount?: number;
          reviewLadderRecordCount?: number;
        };
      };
      expect(emptyBody.data.items).toEqual([]);
      expect(emptyBody.data.totalCount).toBe(0);
      expect(emptyBody.data.nextCursor).toBeNull();

      if (resource === 'penalty-history') {
        expect(emptyBody.data.member.displayId).toMatch(/^MEM-[0-9]{6,}$/);
        expect(emptyBody.data.confirmedMisconductCount).toBe(0);
        expect(emptyBody.data.effectiveActiveMisconductPenaltyCount).toBe(0);
        expect(emptyBody.data.reviewLadderRecordCount).toBe(0);
      }

      // eslint-disable-next-line no-await-in-loop
      const missingMemberResponse = await adminGet(
        `/api/v1/admin/members/${crypto.randomUUID()}/${resource}`
      );
      expect(missingMemberResponse.status).toBe(404);
      // eslint-disable-next-line no-await-in-loop
      expect(((await missingMemberResponse.json()) as ErrorBody).error.code).toBe(
        'MEMBER_NOT_FOUND'
      );

      const invalidCursor = encodeCursor({
        id: crypto.randomUUID(),
        startTime: '2025-05-05T00:00:00.000Z',
      });
      // eslint-disable-next-line no-await-in-loop
      const invalidCursorResponse = await adminGet(`${path}?cursor=${invalidCursor}`);
      expect(invalidCursorResponse.status).toBe(400);
      // eslint-disable-next-line no-await-in-loop
      expect(((await invalidCursorResponse.json()) as ErrorBody).error.code).toBe('INVALID_CURSOR');

      if (resource === 'penalty-history') {
        // eslint-disable-next-line no-await-in-loop
        const invalidLimit = await adminGet(`${path}?limit=51`);
        expect(invalidLimit.status).toBe(400);
        // eslint-disable-next-line no-await-in-loop
        expect(((await invalidLimit.json()) as ErrorBody).error.code).toBe('VALIDATION');
      }
    }

    const missingTagMember = await adminGet(
      `/api/v1/admin/members/${crypto.randomUUID()}/profile-tags`
    );
    expect(missingTagMember.status).toBe(404);
    expect(((await missingTagMember.json()) as ErrorBody).error.code).toBe('MEMBER_NOT_FOUND');
  });
});
