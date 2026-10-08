import { app } from '@/app';
import { db, sql } from '@/database/client';
import { auditRecord } from '@/database/schema/audit.schema';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import {
  proofSubmission,
  quest,
  questAssignment,
  questCandidateTeamV2,
  questCandidateTeamV2Member,
  questCompletionConfirmation,
  questStatus as persistedQuestStatus,
  questV2CompletionConfirmation,
  questV2ProofSubmission,
} from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { createAdminAuth } from '@/modules/auth/admin-auth.config';
import { createStudentAuth } from '@/modules/auth';
import {
  assignmentStatuses,
  questStatuses,
  type AssignmentStatus,
  type QuestParticipation,
  type QuestStatus,
} from '@/modules/quest/shared';

import { Elysia } from 'elysia';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';

const adminEmail = `admin-member-history-${crypto.randomUUID()}@example.com`;
const adminPassword = 'AdminMemberHistoryPass1!';
const memberEmail = `admin-member-history-${crypto.randomUUID()}@ku.th`;
const memberPassword = 'MemberHistoryPass1!';
const targetMemberId = crypto.randomUUID();
const questId = crypto.randomUUID();
const assignmentId = crypto.randomUUID();
const tagId = crypto.randomUUID();
const statusMemberId = crypto.randomUUID();
const cursorMemberId = crypto.randomUUID();
const relatedMemberId = crypto.randomUUID();
const approvedBeforeFailureWorkerId = crypto.randomUUID();
const confirmedBeforeFailureWorkerId = crypto.randomUUID();
const workerOnlyHirerId = crypto.randomUUID();
const emptyMemberId = crypto.randomUUID();
const fixtureMemberIds = [
  targetMemberId,
  statusMemberId,
  cursorMemberId,
  relatedMemberId,
  approvedBeforeFailureWorkerId,
  confirmedBeforeFailureWorkerId,
  workerOnlyHirerId,
  emptyMemberId,
];
const fixtureQuestIds = [questId];
const fixtureAssignmentIds = [assignmentId];
const fixtureProofSubmissionIds: string[] = [];
const questCreatedAt = new Date('2031-04-01T00:00:00.100Z');
const assignmentCreatedAt = new Date('2031-04-01T00:00:00.200Z');
const assignmentStartedAt = new Date('2031-04-01T00:00:01.000Z');
const questStatusChangedAt = new Date('2031-04-01T00:01:00.000Z');

const memberTestAuth = createStudentAuth({
  emailAndPasswordEnabled: true,
  allowEmailSignUp: true,
  autoSignIn: false,
  provisionWalletOnCreate: false,
});
const memberAuthApp = new Elysia({ name: 'admin-member-history-member-auth' }).mount(
  memberTestAuth.handler
);

let adminId = '';
let memberAuthUserId = '';
let adminCookie = '';
let memberCookie = '';

const adminGet = (path: string, cookie = adminCookie) =>
  app.handle(new Request(`http://localhost${path}`, cookie ? { headers: { cookie } } : undefined));

const historyPathFor = (memberId: string) => `/api/v1/admin/members/${memberId}/history`;
const historyPath = historyPathFor(targetMemberId);

type MemberIdentity = {
  id: string;
  displayId: string;
  firstName: string;
  lastName: string;
};

type RelatedMember = {
  role: 'HIRER' | 'WORKER';
  member: MemberIdentity;
  assignmentStatus: string | null;
  assignmentCreatedAt: string | null;
  startedAt: string | null;
  assignmentStatusChangedAt: string | null;
};

type HistoryItem = {
  role: 'HIRER' | 'WORKER';
  createdAt: string;
  assignmentStatus: string | null;
  startedAt: string | null;
  assignmentStatusChangedAt: string | null;
  quest: {
    id: string;
    displayId: string;
    title: string;
    questStatus: string;
    createdAt: string;
    questStatusChangedAt: string | null;
  };
  relatedMembers: RelatedMember[];
};

type HistoryBody = {
  success: true;
  data: {
    member: { displayId: string };
    items: HistoryItem[];
    totalCount: number;
    nextCursor: string | null;
  };
};

type HistoryQuestFixture = {
  id: string;
  title: string;
  questStatus: QuestStatus;
  createdAt: Date;
  questStatusChangedAt: Date | null;
};

const createHistoryQuest = async ({
  hirerId,
  questStatus,
  title,
  createdAt,
  participation = 'SOLO',
  headcount = 1,
  proofRequired = true,
}: {
  hirerId: string;
  questStatus: QuestStatus;
  title: string;
  createdAt: Date;
  participation?: QuestParticipation;
  headcount?: number;
  proofRequired?: boolean;
}): Promise<HistoryQuestFixture> => {
  const id = crypto.randomUUID();
  const questStateEventAt =
    questStatus === 'QUEST_DRAFT' ? null : new Date(createdAt.getTime() + 60_000);
  await db.insert(quest).values({
    id,
    hirerId,
    title,
    condition: 'Complete the history fixture work',
    mode: 'NO_CANDIDATE',
    participation,
    questStatus,
    rewardSatang: 500,
    tagId,
    headcount,
    proofRequired,
    startTime: new Date(createdAt.getTime() + 5_000),
    failedAt: questStatus === 'QUEST_FAILED' ? questStateEventAt : null,
    cancelledAt: questStatus === 'QUEST_CANCELLED' ? questStateEventAt : null,
    createdAt,
    updatedAt: new Date(createdAt.getTime() + 24 * 60 * 60 * 1000),
  });
  fixtureQuestIds.push(id);
  if (
    questStateEventAt &&
    !['QUEST_COMPLETED', 'QUEST_CANCELLED', 'QUEST_FAILED'].includes(questStatus)
  ) {
    await db.insert(auditRecord).values({
      actorType: 'SYSTEM',
      action: 'QUEST_STATE_CHANGED',
      resourceType: 'QUEST',
      resourceId: id,
      newValue: { state: questStatus },
      createdAt: questStateEventAt,
    });
  }
  return {
    id,
    title,
    questStatus,
    createdAt,
    questStatusChangedAt: questStateEventAt,
  };
};

const createHistoryAssignment = async ({
  questId: targetQuestId,
  workerId,
  assignmentStatus,
  createdAt,
  startedAt,
  statusChangedAt,
  recordStatusAudit,
}: {
  questId: string;
  workerId: string;
  assignmentStatus: AssignmentStatus;
  createdAt: Date;
  startedAt: Date | null;
  statusChangedAt: Date | null;
  recordStatusAudit: boolean;
}): Promise<string> => {
  const id = crypto.randomUUID();
  await db.insert(questAssignment).values({
    id,
    questId: targetQuestId,
    workerId,
    assignmentStatus,
    createdAt,
    startedAt,
  });
  fixtureAssignmentIds.push(id);
  if (recordStatusAudit) {
    if (!statusChangedAt) throw new Error('An Assignment audit needs its event time.');
    await db.insert(auditRecord).values({
      actorType: 'SYSTEM',
      action: 'ASSIGNMENT_STATE_CHANGED',
      resourceType: 'ASSIGNMENT',
      resourceId: id,
      oldValue: { state: 'ASSIGNMENT_ACTIVE' },
      newValue: { state: assignmentStatus },
      createdAt: statusChangedAt,
    });
  }
  return id;
};
beforeAll(async () => {
  await sql`select 1`;
  await db.insert(authUser).values([
    {
      id: targetMemberId,
      email: `${targetMemberId}@ku.th`,
      firstName: 'History',
      lastName: 'Member',
    },
    {
      id: statusMemberId,
      email: `${statusMemberId}@ku.th`,
      firstName: 'Status',
      lastName: 'Member',
    },
    {
      id: cursorMemberId,
      email: `${cursorMemberId}@ku.th`,
      firstName: 'Cursor',
      lastName: 'Member',
    },
    {
      id: relatedMemberId,
      email: `${relatedMemberId}@ku.th`,
      firstName: 'Related',
      lastName: 'Worker',
    },
    {
      id: approvedBeforeFailureWorkerId,
      email: `${approvedBeforeFailureWorkerId}@ku.th`,
      firstName: 'Approved',
      lastName: 'Worker',
    },
    {
      id: confirmedBeforeFailureWorkerId,
      email: `${confirmedBeforeFailureWorkerId}@ku.th`,
      firstName: 'Confirmed',
      lastName: 'Worker',
    },
    {
      id: workerOnlyHirerId,
      email: `${workerOnlyHirerId}@ku.th`,
      firstName: 'Worker Only',
      lastName: 'Hirer',
    },
    {
      id: emptyMemberId,
      email: `${emptyMemberId}@ku.th`,
      firstName: 'Empty',
      lastName: 'Member',
    },
  ]);
  await db.insert(tag).values({ id: tagId, name: `Admin Member History ${tagId}` });
  await db.insert(quest).values({
    id: questId,
    hirerId: targetMemberId,
    title: 'History fixture Quest',
    condition: 'Complete the history fixture work',
    mode: 'NO_CANDIDATE',
    participation: 'SOLO',
    questStatus: 'QUEST_IN_PROGRESS',
    rewardSatang: 500,
    tagId,
    headcount: 1,
    startTime: assignmentStartedAt,
    createdAt: questCreatedAt,
    updatedAt: new Date('2031-04-02T00:00:00.000Z'),
  });
  await db.insert(questAssignment).values({
    id: assignmentId,
    questId,
    workerId: targetMemberId,
    assignmentStatus: 'ASSIGNMENT_ACTIVE',
    createdAt: assignmentCreatedAt,
    startedAt: assignmentStartedAt,
  });
  await db.insert(auditRecord).values({
    actorType: 'SYSTEM',
    action: 'QUEST_STATE_CHANGED',
    resourceType: 'QUEST',
    resourceId: questId,
    oldValue: { state: 'QUEST_ASSIGNED' },
    newValue: { state: 'QUEST_IN_PROGRESS' },
    createdAt: questStatusChangedAt,
  });

  const memberSignUp = await memberTestAuth.api.signUpEmail({
    body: {
      email: memberEmail,
      password: memberPassword,
      name: 'History Member Session',
      firstName: 'History',
      lastName: 'Session',
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
      name: 'History Admin',
      firstName: 'History',
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
  if (adminLogin.status !== 200) throw new Error('Admin Session was not created.');
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
  if (memberLogin.status !== 200) throw new Error('Member Session was not created.');
  memberCookie = (memberLogin.headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');
});

afterAll(async () => {
  await db
    .delete(auditRecord)
    .where(inArray(auditRecord.resourceId, [...fixtureQuestIds, ...fixtureAssignmentIds]));
  if (fixtureProofSubmissionIds.length > 0) {
    await db.delete(proofSubmission).where(inArray(proofSubmission.id, fixtureProofSubmissionIds));
  }
  await db.delete(questAssignment).where(inArray(questAssignment.id, fixtureAssignmentIds));
  await db.delete(quest).where(inArray(quest.id, fixtureQuestIds));
  await db.delete(tag).where(eq(tag.id, tagId));
  if (memberAuthUserId) {
    await db.delete(authUser).where(eq(authUser.id, memberAuthUserId));
  }
  await db.delete(authUser).where(inArray(authUser.id, fixtureMemberIds));
  if (adminId) await db.delete(authAdmin).where(eq(authAdmin.id, adminId));
});

describe('Admin Member Quest and Assignment history', () => {
  it('publishes an Admin-only, filtered, paginated history read in OpenAPI', async () => {
    const response = await app.handle(new Request('http://localhost/openapi/json'));
    const document = (await response.json()) as {
      paths: Record<
        string,
        {
          get?: {
            security?: unknown[];
            parameters?: Array<{ name?: string }>;
            responses?: Record<string, unknown>;
          };
        }
      >;
    };
    const operation = document.paths['/api/v1/admin/members/{id}/history']?.get;

    expect(response.status).toBe(200);
    expect(operation).toBeDefined();
    expect(operation?.security).toEqual([{ betterAuthAdminSession: [] }]);
    expect(operation?.parameters?.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['role', 'questStatus', 'assignmentStatus', 'limit', 'cursor'])
    );
    expect(Object.keys(operation?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '400', '401', '403', '404', '500'])
    );
  });

  it('requires an enabled Admin Session and returns separate records for both roles', async () => {
    const anonymous = await adminGet(historyPath, '');
    expect(anonymous.status).toBe(401);

    const member = await adminGet(historyPath, memberCookie);
    expect([401, 403]).toContain(member.status);

    const response = await adminGet(historyPath);
    expect(response.status).toBe(200);
    const body = (await response.json()) as HistoryBody;
    expect(body.data.member.displayId).toMatch(/^MEM-[0-9]{6,}$/);
    expect(body.data.totalCount).toBe(2);
    expect(body.data.nextCursor).toBeNull();
    expect(body.data.items.map(({ role }) => role).sort()).toEqual(['HIRER', 'WORKER']);

    const hirerItem = body.data.items.find(({ role }) => role === 'HIRER');
    const workerItem = body.data.items.find(({ role }) => role === 'WORKER');
    expect(hirerItem).toMatchObject({
      createdAt: questCreatedAt.toISOString(),
      assignmentStatus: null,
      startedAt: null,
      assignmentStatusChangedAt: null,
      quest: {
        id: questId,
        displayId: expect.stringMatching(/^QST-[0-9]{6,}$/),
        title: 'History fixture Quest',
        questStatus: 'QUEST_IN_PROGRESS',
        createdAt: questCreatedAt.toISOString(),
        questStatusChangedAt: '2031-04-01T00:01:00.000000Z',
      },
      relatedMembers: [
        {
          role: 'WORKER',
          member: {
            id: targetMemberId,
            displayId: body.data.member.displayId,
            firstName: 'History',
            lastName: 'Member',
          },
          assignmentStatus: 'ASSIGNMENT_ACTIVE',
          assignmentCreatedAt: assignmentCreatedAt.toISOString(),
          startedAt: assignmentStartedAt.toISOString(),
          assignmentStatusChangedAt: null,
        },
      ],
    });
    expect(workerItem).toMatchObject({
      createdAt: assignmentCreatedAt.toISOString(),
      assignmentStatus: 'ASSIGNMENT_ACTIVE',
      startedAt: assignmentStartedAt.toISOString(),
      assignmentStatusChangedAt: null,
      quest: { id: questId, displayId: expect.stringMatching(/^QST-[0-9]{6,}$/) },
      relatedMembers: [
        {
          role: 'HIRER',
          member: {
            id: targetMemberId,
            displayId: body.data.member.displayId,
            firstName: 'History',
            lastName: 'Member',
          },
          assignmentStatus: null,
          assignmentCreatedAt: null,
          startedAt: null,
          assignmentStatusChangedAt: null,
        },
      ],
    });
    await db.update(authAdmin).set({ disabledAt: new Date() }).where(eq(authAdmin.id, adminId));
    try {
      const disabledAdmin = await adminGet(historyPath);
      expect(disabledAdmin.status).toBe(403);
    } finally {
      await db.update(authAdmin).set({ disabledAt: null }).where(eq(authAdmin.id, adminId));
    }
  });

  it('returns every Quest State and Assignment status with audit dates and Member context', async () => {
    const marker = `history-status-${crypto.randomUUID()}`;
    const firstCreatedAt = new Date('2032-05-01T00:00:00.000Z');
    const questFixtures = await Promise.all(
      questStatuses.map((questStatus, index) =>
        createHistoryQuest({
          hirerId: statusMemberId,
          questStatus,
          title: `${marker} ${questStatus}`,
          createdAt: new Date(firstCreatedAt.getTime() + index * 24 * 60 * 60 * 1000),
          participation: questStatus === 'QUEST_FAILED' ? 'GROUP' : 'SOLO',
          headcount: questStatus === 'QUEST_FAILED' ? 4 : 1,
          proofRequired: questStatus !== 'QUEST_COMPLETED',
        })
      )
    );
    const questsByStatus = new Map<QuestStatus, HistoryQuestFixture>(
      questFixtures.map((fixture): [QuestStatus, HistoryQuestFixture] => [
        fixture.questStatus,
        fixture,
      ])
    );

    // Keep the historical database status visible without making it an active Quest State.
    const disputedQuest = await createHistoryQuest({
      hirerId: statusMemberId,
      questStatus: 'QUEST_DISPUTED' as QuestStatus,
      title: `${marker} QUEST_DISPUTED`,
      createdAt: new Date('2032-06-15T00:00:00.000Z'),
    });
    const completedQuestFixture = questsByStatus.get('QUEST_COMPLETED');
    if (!completedQuestFixture?.questStatusChangedAt) {
      throw new Error('The proof-free completed Quest fixture needs its confirmation time.');
    }
    await db.insert(questCompletionConfirmation).values({
      questId: completedQuestFixture.id,
      workerId: statusMemberId,
      teamId: null,
      confirmedByUserId: statusMemberId,
      confirmedAt: completedQuestFixture.questStatusChangedAt,
    });

    const proofQuestCreatedAt = new Date('2032-06-20T00:00:00.000Z');
    const proofCompletedQuest = await createHistoryQuest({
      hirerId: statusMemberId,
      questStatus: 'QUEST_COMPLETED',
      title: `${marker} GROUP proof completion`,
      createdAt: proofQuestCreatedAt,
      participation: 'GROUP',
      headcount: 3,
    });
    const proofReviewCases = [
      {
        workerId: approvedBeforeFailureWorkerId,
        reviewedAt: new Date(proofQuestCreatedAt.getTime() + 40_000),
      },
      {
        workerId: confirmedBeforeFailureWorkerId,
        reviewedAt: new Date(proofQuestCreatedAt.getTime() + 50_000),
      },
    ];
    await Promise.all(
      proofReviewCases.map(async ({ workerId, reviewedAt }) => {
        await createHistoryAssignment({
          questId: proofCompletedQuest.id,
          workerId,
          assignmentStatus: 'ASSIGNMENT_COMPLETED',
          createdAt: new Date(proofQuestCreatedAt.getTime() + 10_000),
          startedAt: new Date(proofQuestCreatedAt.getTime() + 15_000),
          statusChangedAt: null,
          recordStatusAudit: false,
        });
        const proofId = crypto.randomUUID();
        fixtureProofSubmissionIds.push(proofId);
        await db.insert(proofSubmission).values({
          id: proofId,
          questId: proofCompletedQuest.id,
          workerId,
          teamId: null,
          submittedByUserId: workerId,
          content: 'Approved proof for a completed history Assignment',
          submissionStatus: 'PROOF_APPROVED',
          submittedAt: new Date(reviewedAt.getTime() - 5_000),
          reviewedAt,
        });
      })
    );

    const crossVersionV2ProofReviewedAt = new Date(proofQuestCreatedAt.getTime() + 55_000);
    const crossVersionV2ConfirmedAt = new Date(proofQuestCreatedAt.getTime() + 60_000);
    await createHistoryAssignment({
      questId: proofCompletedQuest.id,
      workerId: workerOnlyHirerId,
      assignmentStatus: 'ASSIGNMENT_COMPLETED',
      createdAt: new Date(proofQuestCreatedAt.getTime() + 30_000),
      startedAt: new Date(proofQuestCreatedAt.getTime() + 35_000),
      statusChangedAt: null,
      recordStatusAudit: false,
    });
    await db.insert(questV2ProofSubmission).values({
      questId: proofCompletedQuest.id,
      workerId: workerOnlyHirerId,
      teamId: null,
      submittedByUserId: workerOnlyHirerId,
      description: 'V2 Proof row for a V1 Quest',
      submissionStatus: 'PROOF_APPROVED',
      sentAt: new Date(crossVersionV2ProofReviewedAt.getTime() - 5_000),
      reviewedAt: crossVersionV2ProofReviewedAt,
      reviewedBy: 'HIRER',
    });
    await db.insert(questV2CompletionConfirmation).values({
      questId: proofCompletedQuest.id,
      workerId: workerOnlyHirerId,
      teamId: null,
      confirmedByUserId: workerOnlyHirerId,
      confirmedAt: crossVersionV2ConfirmedAt,
    });

    const assignmentCases: Array<{
      questStatus: QuestStatus;
      assignmentStatus: AssignmentStatus;
      recordStatusAudit: boolean;
    }> = [
      {
        questStatus: 'QUEST_IN_PROGRESS',
        assignmentStatus: 'ASSIGNMENT_ACTIVE',
        recordStatusAudit: false,
      },
      {
        questStatus: 'QUEST_COMPLETED',
        assignmentStatus: 'ASSIGNMENT_COMPLETED',
        recordStatusAudit: false,
      },
      {
        questStatus: 'QUEST_FAILED',
        assignmentStatus: 'ASSIGNMENT_INCOMPLETE',
        recordStatusAudit: false,
      },
      {
        questStatus: 'QUEST_CANCELLED',
        assignmentStatus: 'ASSIGNMENT_CANCELLED',
        recordStatusAudit: false,
      },
    ];
    const expectedAssignmentDates = new Map<AssignmentStatus, string | null>();
    await Promise.all(
      assignmentCases.map(async (assignmentCase) => {
        const questFixture = questsByStatus.get(assignmentCase.questStatus);
        if (!questFixture) throw new Error('The status fixture Quest is missing.');
        const statusAssignmentCreatedAt = new Date(questFixture.createdAt.getTime() + 1_000);
        const statusChangedAt =
          assignmentCase.recordStatusAudit && questFixture.questStatusChangedAt
            ? new Date(questFixture.questStatusChangedAt.getTime() - 5_000)
            : null;
        const startedAt =
          assignmentCase.assignmentStatus === 'ASSIGNMENT_ACTIVE' ||
          assignmentCase.assignmentStatus === 'ASSIGNMENT_COMPLETED'
            ? new Date(questFixture.createdAt.getTime() + 10_000)
            : null;
        await createHistoryAssignment({
          questId: questFixture.id,
          workerId: statusMemberId,
          assignmentStatus: assignmentCase.assignmentStatus,
          createdAt: statusAssignmentCreatedAt,
          startedAt,
          statusChangedAt,
          recordStatusAudit: assignmentCase.recordStatusAudit,
        });
        const expectedDate =
          assignmentCase.assignmentStatus === 'ASSIGNMENT_ACTIVE'
            ? null
            : (statusChangedAt ?? questFixture.questStatusChangedAt);
        expectedAssignmentDates.set(
          assignmentCase.assignmentStatus,
          expectedDate?.toISOString() ?? null
        );
      })
    );
    const failedQuest = questsByStatus.get('QUEST_FAILED');
    if (!failedQuest?.questStatusChangedAt)
      throw new Error('The failed Quest fixture needs its State event.');
    const lateProofReviewedAt = new Date(failedQuest.questStatusChangedAt.getTime() + 5_000);
    await createHistoryAssignment({
      questId: failedQuest.id,
      workerId: relatedMemberId,
      assignmentStatus: 'ASSIGNMENT_COMPLETED',
      createdAt: new Date(failedQuest.createdAt.getTime() + 10_000),
      startedAt: new Date(failedQuest.createdAt.getTime() + 15_000),
      statusChangedAt: null,
      recordStatusAudit: false,
    });
    const lateProofId = crypto.randomUUID();
    fixtureProofSubmissionIds.push(lateProofId);
    await db.insert(proofSubmission).values({
      id: lateProofId,
      questId: failedQuest.id,
      workerId: relatedMemberId,
      teamId: null,
      submittedByUserId: relatedMemberId,
      content: 'Proof approved after failure',
      submissionStatus: 'PROOF_APPROVED',
      submittedAt: new Date(failedQuest.questStatusChangedAt.getTime() - 5_000),
      reviewedAt: lateProofReviewedAt,
    });

    await createHistoryAssignment({
      questId: failedQuest.id,
      workerId: approvedBeforeFailureWorkerId,
      assignmentStatus: 'ASSIGNMENT_COMPLETED',
      createdAt: new Date(failedQuest.createdAt.getTime() + 20_000),
      startedAt: new Date(failedQuest.createdAt.getTime() + 25_000),
      statusChangedAt: null,
      recordStatusAudit: false,
    });
    const approvedBeforeFailureProofId = crypto.randomUUID();
    fixtureProofSubmissionIds.push(approvedBeforeFailureProofId);
    await db.insert(proofSubmission).values({
      id: approvedBeforeFailureProofId,
      questId: failedQuest.id,
      workerId: approvedBeforeFailureWorkerId,
      teamId: null,
      submittedByUserId: approvedBeforeFailureWorkerId,
      content: 'Proof approved before another Worker failed',
      submissionStatus: 'PROOF_APPROVED',
      submittedAt: new Date(failedQuest.questStatusChangedAt.getTime() - 10_000),
      reviewedAt: new Date(failedQuest.questStatusChangedAt.getTime() - 5_000),
    });

    const confirmedBeforeFailureAt = new Date(failedQuest.questStatusChangedAt.getTime() - 5_000);
    await createHistoryAssignment({
      questId: failedQuest.id,
      workerId: confirmedBeforeFailureWorkerId,
      assignmentStatus: 'ASSIGNMENT_COMPLETED',
      createdAt: new Date(failedQuest.createdAt.getTime() + 30_000),
      startedAt: new Date(failedQuest.createdAt.getTime() + 35_000),
      statusChangedAt: null,
      recordStatusAudit: false,
    });
    await db.insert(questCompletionConfirmation).values({
      questId: failedQuest.id,
      workerId: confirmedBeforeFailureWorkerId,
      teamId: null,
      confirmedByUserId: confirmedBeforeFailureWorkerId,
      confirmedAt: confirmedBeforeFailureAt,
    });

    const openQuest = questsByStatus.get('QUEST_OPEN');
    if (!openQuest) throw new Error('The open Quest fixture is missing.');
    await createHistoryAssignment({
      questId: openQuest.id,
      workerId: relatedMemberId,
      assignmentStatus: 'ASSIGNMENT_ACTIVE',
      createdAt: new Date(openQuest.createdAt.getTime() + 2_000),
      startedAt: null,
      statusChangedAt: null,
      recordStatusAudit: false,
    });

    const workerOnlyQuest = await createHistoryQuest({
      hirerId: workerOnlyHirerId,
      questStatus: 'QUEST_OPEN',
      title: `${marker} worker-only`,
      createdAt: new Date('2032-06-01T00:00:00.000Z'),
    });
    await createHistoryAssignment({
      questId: workerOnlyQuest.id,
      workerId: statusMemberId,
      assignmentStatus: 'ASSIGNMENT_ACTIVE',
      createdAt: new Date('2032-06-01T00:00:01.000Z'),
      startedAt: null,
      statusChangedAt: null,
      recordStatusAudit: false,
    });
    const v2PartialQuestId = crypto.randomUUID();
    const v2PartialAssignmentId = crypto.randomUUID();
    const v2QuestCreatedAt = new Date('2032-06-02T00:00:00.000Z');
    const v2ProofReviewedAt = new Date('2032-06-02T00:00:30.000Z');
    await db.insert(quest).values({
      id: v2PartialQuestId,
      hirerId: workerOnlyHirerId,
      apiVersion: 'v2',
      title: `${marker} v2 partial completion`,
      condition: 'Complete the history fixture work',
      mode: 'NO_CANDIDATE',
      participation: 'GROUP',
      v2Mode: 'FIRST_COME_FIRST_SERVED',
      v2Participation: 'GROUP',
      questStatus: 'QUEST_IN_PROGRESS',
      rewardSatang: 1_000,
      tagId,
      headcount: 2,
      startTime: new Date(v2QuestCreatedAt.getTime() + 5_000),
      dueAt: new Date(v2QuestCreatedAt.getTime() + 20 * 60_000),
      createdAt: v2QuestCreatedAt,
      updatedAt: new Date(v2QuestCreatedAt.getTime() + 24 * 60 * 60 * 1000),
    });
    fixtureQuestIds.push(v2PartialQuestId);
    await db.insert(questAssignment).values({
      id: v2PartialAssignmentId,
      questId: v2PartialQuestId,
      workerId: statusMemberId,
      assignmentStatus: 'ASSIGNMENT_COMPLETED',
      createdAt: new Date(v2QuestCreatedAt.getTime() + 10_000),
      startedAt: new Date(v2QuestCreatedAt.getTime() + 15_000),
    });
    fixtureAssignmentIds.push(v2PartialAssignmentId);
    await db.insert(questV2ProofSubmission).values({
      questId: v2PartialQuestId,
      workerId: statusMemberId,
      teamId: null,
      submittedByUserId: statusMemberId,
      description: 'Approved history proof',
      submissionStatus: 'PROOF_APPROVED',
      sentAt: new Date(v2ProofReviewedAt.getTime() - 5_000),
      reviewedAt: v2ProofReviewedAt,
      reviewedBy: 'HIRER',
    });
    const v2TeamQuestId = crypto.randomUUID();
    const v2TeamId = crypto.randomUUID();
    const v2TeamCreatedAt = new Date('2032-06-03T00:00:00.000Z');
    const v2TeamConfirmedAt = new Date('2032-06-03T00:00:30.000Z');
    await db.insert(quest).values({
      id: v2TeamQuestId,
      hirerId: workerOnlyHirerId,
      apiVersion: 'v2',
      title: `${marker} v2 team completion`,
      condition: 'Complete the history fixture work',
      mode: 'CANDIDATE',
      participation: 'GROUP',
      v2Mode: 'CANDIDATE',
      v2Participation: 'GROUP',
      questStatus: 'QUEST_IN_PROGRESS',
      rewardSatang: 2_000,
      tagId,
      headcount: 2,
      startTime: new Date(v2TeamCreatedAt.getTime() + 5_000),
      dueAt: new Date(v2TeamCreatedAt.getTime() + 20 * 60_000),
      createdAt: v2TeamCreatedAt,
      updatedAt: new Date(v2TeamCreatedAt.getTime() + 24 * 60 * 60 * 1000),
    });
    fixtureQuestIds.push(v2TeamQuestId);
    await db.insert(questCandidateTeamV2).values({
      id: v2TeamId,
      questId: v2TeamQuestId,
      leaderId: statusMemberId,
      name: `${marker} selected team`,
      headcount: 2,
      state: 'TEAM_SELECTED',
      submissionText: 'Selected history team',
      submittedAt: new Date(v2TeamCreatedAt.getTime() + 4_000),
      createdAt: new Date(v2TeamCreatedAt.getTime() + 1_000),
    });
    await db.insert(questCandidateTeamV2Member).values([
      { teamId: v2TeamId, memberId: statusMemberId },
      { teamId: v2TeamId, memberId: relatedMemberId },
    ]);
    const teamAssignmentIds = await Promise.all(
      [statusMemberId, relatedMemberId].map(async (workerId) => {
        const assignmentRecordId = crypto.randomUUID();
        await db.insert(questAssignment).values({
          id: assignmentRecordId,
          questId: v2TeamQuestId,
          workerId,
          assignmentStatus: 'ASSIGNMENT_COMPLETED',
          createdAt: new Date(v2TeamCreatedAt.getTime() + 10_000),
          startedAt: new Date(v2TeamCreatedAt.getTime() + 15_000),
        });
        return assignmentRecordId;
      })
    );
    fixtureAssignmentIds.push(...teamAssignmentIds);
    await db.insert(questV2CompletionConfirmation).values({
      questId: v2TeamQuestId,
      workerId: null,
      teamId: v2TeamId,
      confirmedByUserId: statusMemberId,
      confirmedAt: v2TeamConfirmedAt,
    });

    const v2TerminalQuestId = crypto.randomUUID();
    const v2TerminalAssignmentId = crypto.randomUUID();
    const v2TerminalCreatedAt = new Date('2032-06-21T00:00:00.000Z');
    const v2TerminalConfirmedAt = new Date('2032-06-21T00:00:30.000Z');
    const strayV1ProofReviewedAt = new Date('2032-06-21T00:00:40.000Z');
    const strayV1ConfirmationAt = new Date('2032-06-21T00:00:50.000Z');
    await db.insert(quest).values({
      id: v2TerminalQuestId,
      hirerId: statusMemberId,
      apiVersion: 'v2',
      title: `${marker} v2 terminal completion`,
      condition: 'Complete the history fixture work',
      mode: 'NO_CANDIDATE',
      participation: 'SOLO',
      v2Mode: 'FIRST_COME_FIRST_SERVED',
      v2Participation: 'SINGLE',
      questStatus: 'QUEST_COMPLETED',
      rewardSatang: 1_500,
      tagId,
      headcount: 1,
      startTime: new Date(v2TerminalCreatedAt.getTime() + 5_000),
      dueAt: new Date(v2TerminalCreatedAt.getTime() + 20 * 60_000),
      proofRequired: false,
      createdAt: v2TerminalCreatedAt,
      updatedAt: new Date(v2TerminalCreatedAt.getTime() + 24 * 60 * 60 * 1000),
    });
    fixtureQuestIds.push(v2TerminalQuestId);
    await db.insert(questAssignment).values({
      id: v2TerminalAssignmentId,
      questId: v2TerminalQuestId,
      workerId: relatedMemberId,
      assignmentStatus: 'ASSIGNMENT_COMPLETED',
      createdAt: new Date(v2TerminalCreatedAt.getTime() + 10_000),
      startedAt: new Date(v2TerminalCreatedAt.getTime() + 15_000),
    });
    fixtureAssignmentIds.push(v2TerminalAssignmentId);
    await db.insert(questV2CompletionConfirmation).values({
      questId: v2TerminalQuestId,
      workerId: relatedMemberId,
      teamId: null,
      confirmedByUserId: relatedMemberId,
      confirmedAt: v2TerminalConfirmedAt,
    });
    const strayV1ProofId = crypto.randomUUID();
    fixtureProofSubmissionIds.push(strayV1ProofId);
    await db.insert(proofSubmission).values({
      id: strayV1ProofId,
      questId: v2TerminalQuestId,
      workerId: relatedMemberId,
      teamId: null,
      submittedByUserId: relatedMemberId,
      content: 'Legacy Proof row for a V2 Quest',
      submissionStatus: 'PROOF_APPROVED',
      submittedAt: new Date(v2TerminalConfirmedAt.getTime() - 5_000),
      reviewedAt: strayV1ProofReviewedAt,
    });
    await db.insert(questCompletionConfirmation).values({
      questId: v2TerminalQuestId,
      workerId: relatedMemberId,
      teamId: null,
      confirmedByUserId: relatedMemberId,
      confirmedAt: strayV1ConfirmationAt,
    });

    const allHistoryResponse = await adminGet(`${historyPathFor(statusMemberId)}?limit=50`);
    expect(allHistoryResponse.status).toBe(200);
    const allHistory = (await allHistoryResponse.json()) as HistoryBody;
    expect(allHistory.data.totalCount).toBe(21);

    const hirerResponse = await adminGet(`${historyPathFor(statusMemberId)}?role=HIRER&limit=50`);
    expect(hirerResponse.status).toBe(200);
    const hirerHistory = (await hirerResponse.json()) as HistoryBody;
    expect(hirerHistory.data.totalCount).toBe(14);
    expect(new Set(hirerHistory.data.items.map(({ quest: item }) => item.questStatus))).toEqual(
      new Set(persistedQuestStatus.enumValues)
    );
    const disputedQuestResponse = await adminGet(
      `${historyPathFor(statusMemberId)}?role=HIRER&questStatus=QUEST_DISPUTED`
    );
    expect(disputedQuestResponse.status).toBe(200);
    const disputedQuestBody = (await disputedQuestResponse.json()) as HistoryBody;
    expect(disputedQuestBody.data.totalCount).toBe(1);
    expect(disputedQuestBody.data.items.map(({ quest: item }) => item.id)).toEqual([
      disputedQuest.id,
    ]);

    for (const fixture of questsByStatus.values()) {
      const item = hirerHistory.data.items.find(
        ({ quest: questItem }) => questItem.id === fixture.id
      );
      expect(item?.quest.questStatus).toBe(fixture.questStatus);
      expect(
        item?.quest.questStatusChangedAt
          ? new Date(item.quest.questStatusChangedAt).toISOString()
          : null
      ).toBe(fixture.questStatusChangedAt?.toISOString() ?? null);
      expect(item?.quest.questStatusChangedAt).not.toBe(
        new Date(fixture.createdAt.getTime() + 24 * 60 * 60 * 1000).toISOString()
      );
    }

    const proofCompletedQuestItem = hirerHistory.data.items.find(
      ({ quest: item }) => item.id === proofCompletedQuest.id
    );
    if (!proofCompletedQuestItem?.quest.questStatusChangedAt) {
      throw new Error('The proof-required GROUP Quest needs its last Proof review time.');
    }
    const lastProofReviewAt = proofReviewCases[1]?.reviewedAt;
    if (!lastProofReviewAt) throw new Error('The latest Proof review fixture is missing.');
    expect(new Date(proofCompletedQuestItem.quest.questStatusChangedAt).toISOString()).toBe(
      lastProofReviewAt.toISOString()
    );
    for (const { workerId, reviewedAt } of proofReviewCases) {
      const completedWorker = proofCompletedQuestItem.relatedMembers.find(
        ({ member }) => member.id === workerId
      );
      expect(completedWorker?.assignmentStatus).toBe('ASSIGNMENT_COMPLETED');
      if (!completedWorker?.assignmentStatusChangedAt) {
        throw new Error('A completed V1 Assignment needs its own Proof review time.');
      }
      expect(new Date(completedWorker.assignmentStatusChangedAt).toISOString()).toBe(
        reviewedAt.toISOString()
      );
    }
    const crossVersionV2Worker = proofCompletedQuestItem.relatedMembers.find(
      ({ member }) => member.id === workerOnlyHirerId
    );
    expect(crossVersionV2Worker?.assignmentStatus).toBe('ASSIGNMENT_COMPLETED');
    if (!crossVersionV2Worker?.assignmentStatusChangedAt) {
      throw new Error('A V1 Assignment must ignore V2 completion events.');
    }
    expect(new Date(crossVersionV2Worker.assignmentStatusChangedAt).toISOString()).toBe(
      lastProofReviewAt.toISOString()
    );

    const v2TerminalItem = hirerHistory.data.items.find(
      ({ quest: item }) => item.id === v2TerminalQuestId
    );
    expect(v2TerminalItem?.quest.questStatus).toBe('QUEST_COMPLETED');
    if (!v2TerminalItem?.quest.questStatusChangedAt) {
      throw new Error('A V2 Quest must ignore V1 completion events.');
    }
    expect(new Date(v2TerminalItem.quest.questStatusChangedAt).toISOString()).toBe(
      v2TerminalConfirmedAt.toISOString()
    );
    const v2TerminalWorker = v2TerminalItem.relatedMembers.find(
      ({ member }) => member.id === relatedMemberId
    );
    expect(v2TerminalWorker?.assignmentStatus).toBe('ASSIGNMENT_COMPLETED');
    if (!v2TerminalWorker?.assignmentStatusChangedAt) {
      throw new Error('A V2 Assignment must ignore V1 completion events.');
    }
    expect(new Date(v2TerminalWorker.assignmentStatusChangedAt).toISOString()).toBe(
      v2TerminalConfirmedAt.toISOString()
    );

    const draftQuest = questsByStatus.get('QUEST_DRAFT');
    expect(
      hirerHistory.data.items.find(({ quest: item }) => item.id === draftQuest?.id)?.relatedMembers
    ).toEqual([]);
    const openQuestItem = hirerHistory.data.items.find(
      ({ quest: item }) => item.id === openQuest.id
    );
    expect(openQuestItem?.relatedMembers).toMatchObject([
      {
        role: 'WORKER',
        member: {
          id: relatedMemberId,
          displayId: expect.stringMatching(/^MEM-[0-9]{6,}$/),
          firstName: 'Related',
          lastName: 'Worker',
        },
        assignmentStatus: 'ASSIGNMENT_ACTIVE',
      },
    ]);
    const failedQuestFixture = questsByStatus.get('QUEST_FAILED');
    const failedQuestItem = hirerHistory.data.items.find(
      ({ quest: item }) => item.id === failedQuestFixture?.id
    );
    const lateApprovedWorker = failedQuestItem?.relatedMembers.find(
      ({ member }) => member.id === relatedMemberId
    );
    expect(lateApprovedWorker?.assignmentStatus).toBe('ASSIGNMENT_COMPLETED');
    expect(
      lateApprovedWorker?.assignmentStatusChangedAt
        ? new Date(lateApprovedWorker.assignmentStatusChangedAt).toISOString()
        : null
    ).toBe(lateProofReviewedAt.toISOString());

    const previouslyApprovedWorker = failedQuestItem?.relatedMembers.find(
      ({ member }) => member.id === approvedBeforeFailureWorkerId
    );
    expect(previouslyApprovedWorker?.assignmentStatus).toBe('ASSIGNMENT_COMPLETED');
    if (!previouslyApprovedWorker?.assignmentStatusChangedAt) {
      throw new Error('A previously approved Worker Assignment needs the Quest failure time.');
    }
    expect(new Date(previouslyApprovedWorker.assignmentStatusChangedAt).toISOString()).toBe(
      failedQuest.questStatusChangedAt.toISOString()
    );

    const confirmedBeforeFailureWorker = failedQuestItem?.relatedMembers.find(
      ({ member }) => member.id === confirmedBeforeFailureWorkerId
    );
    expect(confirmedBeforeFailureWorker?.assignmentStatus).toBe('ASSIGNMENT_COMPLETED');
    if (!confirmedBeforeFailureWorker?.assignmentStatusChangedAt) {
      throw new Error('A proof-free Worker Assignment needs its confirmation time.');
    }
    expect(new Date(confirmedBeforeFailureWorker.assignmentStatusChangedAt).toISOString()).toBe(
      confirmedBeforeFailureAt.toISOString()
    );

    const workerResponse = await adminGet(`${historyPathFor(statusMemberId)}?role=WORKER&limit=50`);
    expect(workerResponse.status).toBe(200);
    const workerHistory = (await workerResponse.json()) as HistoryBody;
    expect(workerHistory.data.totalCount).toBe(7);
    const v2PartialItem = workerHistory.data.items.find(
      ({ quest: item }) => item.id === v2PartialQuestId
    );
    expect(v2PartialItem?.assignmentStatus).toBe('ASSIGNMENT_COMPLETED');
    if (!v2PartialItem?.assignmentStatusChangedAt) {
      throw new Error('A completed partial Assignment needs its Proof Submission review time.');
    }
    expect(new Date(v2PartialItem.assignmentStatusChangedAt).toISOString()).toBe(
      v2ProofReviewedAt.toISOString()
    );
    const v2TeamItem = workerHistory.data.items.find(
      ({ quest: item }) => item.id === v2TeamQuestId
    );
    expect(v2TeamItem?.assignmentStatus).toBe('ASSIGNMENT_COMPLETED');
    if (!v2TeamItem?.assignmentStatusChangedAt) {
      throw new Error('A Candidate Team Assignment needs its confirmation time.');
    }
    expect(new Date(v2TeamItem.assignmentStatusChangedAt).toISOString()).toBe(
      v2TeamConfirmedAt.toISOString()
    );
    const statusQuestIds = new Set([...questsByStatus.values()].map(({ id }) => id));
    const statusWorkerItems = workerHistory.data.items.filter(({ quest: item }) =>
      statusQuestIds.has(item.id)
    );
    expect(statusWorkerItems).toHaveLength(4);
    expect(new Set(statusWorkerItems.map(({ assignmentStatus }) => assignmentStatus))).toEqual(
      new Set(assignmentStatuses)
    );

    for (const assignmentCase of assignmentCases) {
      const item = statusWorkerItems.find(
        ({ assignmentStatus }) => assignmentStatus === assignmentCase.assignmentStatus
      );
      const expectedDate = expectedAssignmentDates.get(assignmentCase.assignmentStatus) ?? null;
      expect(
        item?.assignmentStatusChangedAt
          ? new Date(item.assignmentStatusChangedAt).toISOString()
          : null
      ).toBe(expectedDate);
    }

    const workerOnlyItem = workerHistory.data.items.find(
      ({ quest: item }) => item.id === workerOnlyQuest.id
    );
    expect(workerOnlyItem).toMatchObject({
      role: 'WORKER',
      relatedMembers: [
        {
          role: 'HIRER',
          member: {
            id: workerOnlyHirerId,
            displayId: expect.stringMatching(/^MEM-[0-9]{6,}$/),
            firstName: 'Worker Only',
            lastName: 'Hirer',
          },
        },
      ],
    });
    const teamHirerResponse = await adminGet(
      `${historyPathFor(workerOnlyHirerId)}?role=HIRER&questStatus=QUEST_IN_PROGRESS&limit=50`
    );
    const teamHirerBody = (await teamHirerResponse.json()) as HistoryBody;
    expect(teamHirerBody.data.totalCount).toBe(2);
    const teamHirerItem = teamHirerBody.data.items.find(
      ({ quest: item }) => item.id === v2TeamQuestId
    );
    expect(teamHirerItem?.relatedMembers.map(({ member }) => member.id).sort()).toEqual(
      [statusMemberId, relatedMemberId].sort()
    );
    expect(teamHirerItem?.relatedMembers.map(({ assignmentStatus }) => assignmentStatus)).toEqual([
      'ASSIGNMENT_COMPLETED',
      'ASSIGNMENT_COMPLETED',
    ]);
    expect(
      teamHirerItem?.relatedMembers.map(({ assignmentStatusChangedAt }) =>
        assignmentStatusChangedAt ? new Date(assignmentStatusChangedAt).toISOString() : null
      )
    ).toEqual([v2TeamConfirmedAt.toISOString(), v2TeamConfirmedAt.toISOString()]);

    const failedQuests = await adminGet(
      `${historyPathFor(statusMemberId)}?role=HIRER&questStatus=QUEST_FAILED`
    );
    expect((await failedQuests.json()).data).toMatchObject({
      totalCount: 1,
      items: [{ role: 'HIRER', quest: { questStatus: 'QUEST_FAILED' } }],
    });

    const incompleteHistory = await adminGet(
      `${historyPathFor(statusMemberId)}?assignmentStatus=ASSIGNMENT_INCOMPLETE`
    );
    const incompleteBody = (await incompleteHistory.json()) as HistoryBody;
    expect(incompleteBody.data.totalCount).toBe(2);
    expect(incompleteBody.data.items.map(({ role }) => role).sort()).toEqual(['HIRER', 'WORKER']);
    const incompleteHirer = incompleteBody.data.items.find(({ role }) => role === 'HIRER');
    const incompleteWorker = incompleteBody.data.items.find(({ role }) => role === 'WORKER');
    expect(incompleteHirer?.quest.questStatus).toBe('QUEST_FAILED');
    expect(incompleteHirer?.relatedMembers.map(({ assignmentStatus }) => assignmentStatus)).toEqual(
      ['ASSIGNMENT_INCOMPLETE']
    );
    expect(incompleteWorker?.assignmentStatus).toBe('ASSIGNMENT_INCOMPLETE');

    const completedWorker = await adminGet(
      `${historyPathFor(statusMemberId)}?role=WORKER&assignmentStatus=ASSIGNMENT_COMPLETED`
    );
    const completedWorkerBody = (await completedWorker.json()) as HistoryBody;
    expect(completedWorkerBody.data.totalCount).toBe(3);
    expect(
      completedWorkerBody.data.items.every(
        ({ role, assignmentStatus }) =>
          role === 'WORKER' && assignmentStatus === 'ASSIGNMENT_COMPLETED'
      )
    ).toBe(true);
    expect(new Set(completedWorkerBody.data.items.map(({ quest: item }) => item.id))).toEqual(
      new Set([completedQuestFixture.id, v2PartialQuestId, v2TeamQuestId])
    );
  });

  it('walks both roles once across equal and sub-millisecond timestamps', async () => {
    const marker = `history-cursor-${crypto.randomUUID()}`;
    const timestampValues = ['2037-01-01T00:00:00.100100Z', '2037-01-01T00:00:00.100800Z'];
    const expectedRecords: Array<{
      role: 'HIRER' | 'WORKER';
      questId: string;
      recordId: string;
      createdAt: string;
    }> = [];

    const expectedRecordGroups = await Promise.all(
      timestampValues.map(async (createdAt, index) => {
        const questFixture = await createHistoryQuest({
          hirerId: cursorMemberId,
          questStatus: 'QUEST_OPEN',
          title: `${marker} ${index}`,
          createdAt: new Date(createdAt),
        });
        const assignmentRecordId = await createHistoryAssignment({
          questId: questFixture.id,
          workerId: cursorMemberId,
          assignmentStatus: 'ASSIGNMENT_ACTIVE',
          createdAt: new Date(createdAt),
          startedAt: null,
          statusChangedAt: null,
          recordStatusAudit: false,
        });
        await sql`
          update quest
          set created_at = ${createdAt}::timestamptz
          where id = ${questFixture.id}
        `;
        await sql`
          update quest_assignment
          set created_at = ${createdAt}::timestamptz
          where id = ${assignmentRecordId}
        `;
        return [
          {
            role: 'HIRER' as const,
            questId: questFixture.id,
            recordId: questFixture.id,
            createdAt,
          },
          {
            role: 'WORKER' as const,
            questId: questFixture.id,
            recordId: assignmentRecordId,
            createdAt,
          },
        ];
      })
    );
    expectedRecords.push(...expectedRecordGroups.flat());

    const compareDescending = (left: string, right: string): number =>
      left < right ? 1 : left > right ? -1 : 0;
    expectedRecords.sort(
      (left, right) =>
        compareDescending(left.createdAt, right.createdAt) ||
        compareDescending(left.recordId, right.recordId) ||
        compareDescending(left.role, right.role)
    );

    const items: HistoryItem[] = [];
    let cursor: string | null = null;
    // Each cursor comes from the prior page, so keep the page requests sequential.
    for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
      const query = new URLSearchParams({ limit: '1' });
      if (cursor) query.set('cursor', cursor);
      // eslint-disable-next-line no-await-in-loop
      const response = await adminGet(`${historyPathFor(cursorMemberId)}?${query}`);
      expect(response.status).toBe(200);
      // eslint-disable-next-line no-await-in-loop
      const body = (await response.json()) as HistoryBody;
      expect(body.data.totalCount).toBe(4);
      expect(body.data.items).toHaveLength(1);
      items.push(...body.data.items);
      cursor = body.data.nextCursor;
      if (!cursor) break;
    }

    expect(cursor).toBeNull();
    expect(items.map(({ role, quest: item }) => `${role}:${item.id}`)).toEqual(
      expectedRecords.map(({ role, questId: id }) => `${role}:${id}`)
    );
    const filteredHirerFirstPage = await adminGet(
      `${historyPathFor(cursorMemberId)}?role=HIRER&limit=1`
    );
    expect(filteredHirerFirstPage.status).toBe(200);
    const filteredHirerCursor = ((await filteredHirerFirstPage.json()) as HistoryBody).data
      .nextCursor;
    if (!filteredHirerCursor) throw new Error('The Hirer cursor fixture needs another page.');

    const roleMismatch = await adminGet(
      `${historyPathFor(cursorMemberId)}?${new URLSearchParams({
        role: 'WORKER',
        limit: '1',
        cursor: filteredHirerCursor,
      })}`
    );
    expect(roleMismatch.status).toBe(400);
    expect((await roleMismatch.json()).error.code).toBe('INVALID_CURSOR');

    const questStatusMismatch = await adminGet(
      `${historyPathFor(cursorMemberId)}?${new URLSearchParams({
        role: 'HIRER',
        questStatus: 'QUEST_FAILED',
        limit: '1',
        cursor: filteredHirerCursor,
      })}`
    );
    expect(questStatusMismatch.status).toBe(400);
    expect((await questStatusMismatch.json()).error.code).toBe('INVALID_CURSOR');

    const filteredWorkerFirstPage = await adminGet(
      `${historyPathFor(cursorMemberId)}?role=WORKER&limit=1`
    );
    expect(filteredWorkerFirstPage.status).toBe(200);
    const filteredWorkerCursor = ((await filteredWorkerFirstPage.json()) as HistoryBody).data
      .nextCursor;
    if (!filteredWorkerCursor) throw new Error('The Worker cursor fixture needs another page.');

    const assignmentStatusMismatch = await adminGet(
      `${historyPathFor(cursorMemberId)}?${new URLSearchParams({
        role: 'WORKER',
        assignmentStatus: 'ASSIGNMENT_COMPLETED',
        limit: '1',
        cursor: filteredWorkerCursor,
      })}`
    );
    expect(assignmentStatusMismatch.status).toBe(400);
    expect((await assignmentStatusMismatch.json()).error.code).toBe('INVALID_CURSOR');
  });

  it('returns empty history, missing-Member, and invalid-cursor responses separately', async () => {
    const emptyResponse = await adminGet(historyPathFor(emptyMemberId));
    expect(emptyResponse.status).toBe(200);
    expect((await emptyResponse.json()).data).toMatchObject({
      items: [],
      totalCount: 0,
      nextCursor: null,
    });

    const missingMember = await adminGet(historyPathFor(crypto.randomUUID()));
    expect(missingMember.status).toBe(404);
    expect((await missingMember.json()).error.code).toBe('MEMBER_NOT_FOUND');

    const malformedCursorQuery = new URLSearchParams({ cursor: 'not-valid-base64url!!' });
    const malformedCursor = await adminGet(
      `${historyPathFor(emptyMemberId)}?${malformedCursorQuery}`
    );
    expect(malformedCursor.status).toBe(400);
    expect((await malformedCursor.json()).error.code).toBe('INVALID_CURSOR');

    const firstCursorPage = await adminGet(`${historyPathFor(cursorMemberId)}?limit=1`);
    const firstCursorBody = (await firstCursorPage.json()) as HistoryBody;
    const crossMemberCursorQuery = new URLSearchParams({
      cursor: firstCursorBody.data.nextCursor!,
    });
    const crossMemberCursor = await adminGet(
      `${historyPathFor(emptyMemberId)}?${crossMemberCursorQuery}`
    );
    expect(crossMemberCursor.status).toBe(400);
    expect((await crossMemberCursor.json()).error.code).toBe('INVALID_CURSOR');
  });
});
