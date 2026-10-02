import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';
import {
  proofSubmission,
  quest,
  questAssignment,
  questCommand,
  questTeam,
  questTeamInvitation,
} from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { runQuestLifecycleWorker } from '@/modules/quest/lifecycle';
import { questV2Storage } from '@/modules/quest/v2';
import { questV2ImageUploadOperationScope } from '@/modules/quest/v2';
import { workChatMembershipWriter } from '@/modules/work-chat';

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
  type Mock,
} from 'bun:test';

const hirerId = crypto.randomUUID();
const workerId = crypto.randomUUID();
const secondWorkerId = crypto.randomUUID();
const tagId = crypto.randomUUID();
const testNow = new Date('2026-08-27T12:00:00.000Z');
const questIds: string[] = [];
const teamIds: string[] = [];
const invitationIds: string[] = [];
const cleanupFileIds: string[] = [];
let applySpy: Mock<typeof workChatMembershipWriter.applyQuestTransition> | undefined;

const createQuest = async (input: Partial<typeof quest.$inferInsert> = {}) => {
  const id = crypto.randomUUID();
  questIds.push(id);
  await db.insert(quest).values({
    id,
    hirerId,
    title: 'Lifecycle worker test',
    condition: 'Done',
    mode: 'NO_CANDIDATE',
    participation: 'SOLO',
    questStatus: 'QUEST_IN_PROGRESS',
    rewardSatang: 100,
    tagId,
    headcount: 1,
    startTime: new Date(testNow.getTime() - 60 * 60 * 1000),
    dueAt: new Date(testNow.getTime() + 60 * 60 * 1000),
    ...input,
  });
  return id;
};

const addAssignment = async (questId: string, assignmentWorkerId = workerId) => {
  await db
    .insert(questAssignment)
    .values({ questId, workerId: assignmentWorkerId, assignmentStatus: 'ASSIGNMENT_ACTIVE' });
};

beforeEach(() => {
  applySpy = spyOn(workChatMembershipWriter, 'applyQuestTransition').mockImplementation(
    async () => ({
      conversationId: 'lifecycle-test-conversation',
      outcome: 'APPLIED',
    })
  );
});

beforeAll(async () => {
  try {
    await sql`select 1`;
  } catch (cause) {
    throw new Error('These tests need PostgreSQL. Start the local database first.', { cause });
  }
  await db.insert(authUser).values([
    { id: hirerId, email: `${hirerId}@ku.th`, firstName: 'Lifecycle', lastName: 'Hirer' },
    { id: workerId, email: `${workerId}@ku.th`, firstName: 'Lifecycle', lastName: 'Worker' },
    {
      id: secondWorkerId,
      email: `${secondWorkerId}@ku.th`,
      firstName: 'Lifecycle',
      lastName: 'Second Worker',
    },
  ]);
  await db.insert(tag).values({ id: tagId, name: `Lifecycle ${tagId}` });
});

afterAll(async () => {
  applySpy?.mockRestore();
  await db.delete(questCommand).where(eq(questCommand.principalUserId, hirerId));
  await db.delete(file).where(inArray(file.id, cleanupFileIds));
  await db.delete(quest).where(inArray(quest.id, questIds));
  await db.delete(questTeam).where(inArray(questTeam.id, teamIds));
  await db.delete(questTeamInvitation).where(inArray(questTeamInvitation.id, invitationIds));
  await db.delete(tag).where(eq(tag.id, tagId));
  await db.delete(authUser).where(inArray(authUser.id, [hirerId, workerId, secondWorkerId]));
});

afterEach(() => mock.restore());

describe('Quest lifecycle worker', () => {
  it('does not start assigned Quests when startTime arrives', async () => {
    const dueId = await createQuest({
      questStatus: 'QUEST_ASSIGNED',
      startTime: new Date(testNow.getTime() - 1),
      dueAt: new Date(testNow.getTime() + 60 * 60 * 1000),
    });
    const futureId = await createQuest({
      questStatus: 'QUEST_ASSIGNED',
      startTime: new Date(testNow.getTime() + 60 * 60 * 1000),
      dueAt: new Date(testNow.getTime() + 2 * 60 * 60 * 1000),
    });
    await addAssignment(dueId);
    await addAssignment(futureId);

    await runQuestLifecycleWorker({
      clock: { now: () => testNow },
      autoApprove: async () => [],
    });

    const rows = await db
      .select({ id: quest.id, status: quest.questStatus, startedAt: questAssignment.startedAt })
      .from(quest)
      .leftJoin(questAssignment, eq(questAssignment.questId, quest.id))
      .where(inArray(quest.id, [dueId, futureId]));
    expect(rows.find((row) => row.id === dueId)).toMatchObject({
      status: 'QUEST_ASSIGNED',
      startedAt: null,
    });
    expect(rows.find((row) => row.id === futureId)).toMatchObject({
      status: 'QUEST_ASSIGNED',
      startedAt: null,
    });
  });

  it('leaves an assigned Quest unchanged across concurrent worker sweeps', async () => {
    const questId = await createQuest({
      questStatus: 'QUEST_ASSIGNED',
      startTime: new Date(testNow.getTime() - 1),
    });
    await addAssignment(questId);
    const options = { clock: { now: () => testNow }, autoApprove: async () => [] };
    await Promise.all([runQuestLifecycleWorker(options), runQuestLifecycleWorker(options)]);
    const [row] = await db
      .select({ status: quest.questStatus, startedAt: questAssignment.startedAt })
      .from(quest)
      .innerJoin(questAssignment, eq(questAssignment.questId, quest.id))
      .where(eq(quest.id, questId));
    expect(row?.status).toBe('QUEST_ASSIGNED');
    expect(row?.startedAt).toBeNull();
  });
  it('fails a v2 assigned Quest at dueAt when the Worker has not started', async () => {
    const questId = await createQuest({
      apiVersion: 'v2',
      v2Mode: 'FIRST_COME_FIRST_SERVED',
      v2Participation: 'SINGLE',
      questStatus: 'QUEST_ASSIGNED',
      dueAt: new Date(testNow.getTime() - 1),
    });
    await addAssignment(questId);

    const result = await runQuestLifecycleWorker({
      clock: { now: () => testNow },
      autoApprove: async () => [],
    });

    expect(result.failedQuestIds).toContain(questId);
    const [failed] = await db
      .select({ state: quest.questStatus, assignmentStatus: questAssignment.assignmentStatus })
      .from(quest)
      .innerJoin(questAssignment, eq(questAssignment.questId, quest.id))
      .where(eq(quest.id, questId));
    expect(failed).toEqual({
      state: 'QUEST_FAILED',
      assignmentStatus: 'ASSIGNMENT_INCOMPLETE',
    });
  });

  it('fails a legacy assigned Quest at dueAt when the Worker has not started', async () => {
    const questId = await createQuest({
      questStatus: 'QUEST_ASSIGNED',
      dueAt: new Date(testNow.getTime() - 1),
    });
    await addAssignment(questId);

    const result = await runQuestLifecycleWorker({
      clock: { now: () => testNow },
      autoApprove: async () => [],
    });

    expect(result.failedQuestIds).toContain(questId);
    const [failed] = await db
      .select({ state: quest.questStatus, assignmentStatus: questAssignment.assignmentStatus })
      .from(quest)
      .innerJoin(questAssignment, eq(questAssignment.questId, quest.id))
      .where(eq(quest.id, questId));
    expect(failed).toEqual({
      state: 'QUEST_FAILED',
      assignmentStatus: 'ASSIGNMENT_INCOMPLETE',
    });
  });

  it('marks only GROUP + FCFS Workers who missed Start Work incomplete at dueAt', async () => {
    const questId = await createQuest({
      participation: 'GROUP',
      headcount: 2,
      questStatus: 'QUEST_ASSIGNED',
      dueAt: new Date(testNow.getTime() - 1),
    });
    await addAssignment(questId, workerId);
    await addAssignment(questId, secondWorkerId);
    await db
      .update(questAssignment)
      .set({ startedAt: new Date(testNow.getTime() - 60_000) })
      .where(and(eq(questAssignment.questId, questId), eq(questAssignment.workerId, workerId)));

    const result = await runQuestLifecycleWorker({
      clock: { now: () => testNow },
      autoApprove: async () => [],
    });

    expect(result.failedQuestIds).toContain(questId);
    const [current] = await db
      .select({ questStatus: quest.questStatus })
      .from(quest)
      .where(eq(quest.id, questId));
    const assignments = await db
      .select({ workerId: questAssignment.workerId, status: questAssignment.assignmentStatus })
      .from(questAssignment)
      .where(eq(questAssignment.questId, questId));
    expect(current?.questStatus).toBe('QUEST_FAILED');
    expect(assignments).toHaveLength(2);
    expect(assignments).toContainEqual({ workerId, status: 'ASSIGNMENT_ACTIVE' });
    expect(assignments).toContainEqual({
      workerId: secondWorkerId,
      status: 'ASSIGNMENT_INCOMPLETE',
    });
  });

  it('marks all GROUP + CANDIDATE Assignments incomplete when the Team Leader misses Start Work', async () => {
    const questId = await createQuest({
      mode: 'CANDIDATE',
      participation: 'GROUP',
      headcount: 2,
      questStatus: 'QUEST_ASSIGNED',
      dueAt: new Date(testNow.getTime() - 1),
    });
    const teamId = crypto.randomUUID();
    teamIds.push(teamId);
    await db.insert(questTeam).values({
      id: teamId,
      questId,
      leaderId: workerId,
      name: 'Start deadline team',
      teamStatus: 'TEAM_SELECTED',
    });
    await addAssignment(questId, workerId);
    await addAssignment(questId, secondWorkerId);

    const result = await runQuestLifecycleWorker({
      clock: { now: () => testNow },
      autoApprove: async () => [],
    });

    expect(result.failedQuestIds).toContain(questId);
    const statuses = await db
      .select({ status: questAssignment.assignmentStatus })
      .from(questAssignment)
      .where(eq(questAssignment.questId, questId));
    expect(statuses).toEqual([
      { status: 'ASSIGNMENT_INCOMPLETE' },
      { status: 'ASSIGNMENT_INCOMPLETE' },
    ]);
  });

  it('fails due Quests with missing Proof or confirmation, but keeps a submitted Proof path', async () => {
    const missingProofId = await createQuest({ dueAt: new Date(testNow.getTime() - 1) });
    const missingConfirmationId = await createQuest({
      proofRequired: false,
      dueAt: new Date(testNow.getTime() - 1),
    });
    const submittedId = await createQuest({
      questStatus: 'QUEST_SUBMITTED',
      dueAt: new Date(testNow.getTime() - 1),
    });
    await addAssignment(missingProofId);
    await addAssignment(missingConfirmationId);
    await addAssignment(submittedId);
    await db.insert(proofSubmission).values({
      questId: submittedId,
      workerId,
      submittedByUserId: workerId,
      content: 'Done',
      submissionStatus: 'PROOF_PENDING',
      submittedAt: new Date(testNow.getTime() - 2 * 60 * 60 * 1000),
    });

    const result = await runQuestLifecycleWorker({
      clock: { now: () => testNow },
      autoApprove: async () => [],
    });
    expect(result.failedQuestIds).toEqual(
      expect.arrayContaining([missingProofId, missingConfirmationId])
    );
    const rows = await db
      .select({ id: quest.id, status: quest.questStatus, failedAt: quest.failedAt })
      .from(quest)
      .where(inArray(quest.id, [missingProofId, missingConfirmationId, submittedId]));
    expect(rows.find((row) => row.id === missingProofId)?.status).toBe('QUEST_FAILED');
    expect(rows.find((row) => row.id === missingProofId)?.failedAt?.getTime()).toBe(
      testNow.getTime()
    );
    expect(rows.find((row) => row.id === missingConfirmationId)?.status).toBe('QUEST_FAILED');
    expect(rows.find((row) => row.id === submittedId)?.status).toBe('QUEST_SUBMITTED');
  });

  it('expires only pending invitations and delegates proof auto-approval to its seam', async () => {
    const questId = await createQuest({
      mode: 'CANDIDATE',
      participation: 'GROUP',
      questStatus: 'QUEST_OPEN',
      headcount: 1,
    });
    const teamId = crypto.randomUUID();
    teamIds.push(teamId);
    await db
      .insert(questTeam)
      .values({ id: teamId, questId, leaderId: workerId, name: 'Lifecycle team' });
    const invitationId = crypto.randomUUID();
    invitationIds.push(invitationId);
    await db.insert(questTeamInvitation).values({
      id: invitationId,
      teamId,
      invitedUserId: hirerId,
      invitedByUserId: workerId,
      invitationStatus: 'INVITATION_PENDING',
      createdAt: new Date(testNow.getTime() - 2 * 24 * 60 * 60 * 1000),
      expiresAt: new Date(testNow.getTime() - 24 * 60 * 60 * 1000),
    });
    let receivedNow: Date | undefined;
    const result = await runQuestLifecycleWorker({
      clock: { now: () => testNow },
      autoApprove: async (now) => {
        receivedNow = now;
        return ['proof-id'];
      },
    });
    expect(receivedNow?.getTime()).toBe(testNow.getTime());
    expect(result.autoApprovedProofIds).toEqual(['proof-id']);
    const [invitation] = await db
      .select({
        status: questTeamInvitation.invitationStatus,
        respondedAt: questTeamInvitation.respondedAt,
      })
      .from(questTeamInvitation)
      .where(
        and(
          eq(questTeamInvitation.id, invitationId),
          eq(questTeamInvitation.invitationStatus, 'INVITATION_EXPIRED')
        )
      );
    expect(invitation?.respondedAt?.getTime()).toBe(testNow.getTime());
  });

  it('recovers an expired Quest Image upload manifest before the lifecycle sweep continues', async () => {
    const key = 'lifecycle-expired-image-upload';
    const object = {
      bucket: 'test-bucket',
      objectKey: `quests/v2/${hirerId}/lifecycle-crashed-upload`,
    };
    await db.insert(questCommand).values({
      principalUserId: hirerId,
      operationScope: questV2ImageUploadOperationScope,
      key,
      requestHash: 'c'.repeat(64),
      resultData: { upload: { objects: [object] } },
      processingStatus: 'PROCESSING',
      expiresAt: new Date(testNow.getTime() - 1),
    });
    const deleteObject = spyOn(questV2Storage, 'delete').mockResolvedValue();

    const result = await runQuestLifecycleWorker({
      clock: { now: () => testNow },
      autoApprove: async () => [],
    });

    expect(result.errors).toEqual([]);
    expect(deleteObject).toHaveBeenCalledWith(object.bucket, object.objectKey);
    expect(
      await db
        .select({ status: questCommand.processingStatus })
        .from(questCommand)
        .where(eq(questCommand.key, key))
    ).toEqual([{ status: 'COMPLETED' }]);
  });

  it('reports image cleanup errors and continues lifecycle processing', async () => {
    const questId = await createQuest({
      questStatus: 'QUEST_ASSIGNED',
      startTime: new Date(testNow.getTime() - 1),
    });
    await addAssignment(questId);
    const cleanupFileId = crypto.randomUUID();
    cleanupFileIds.push(cleanupFileId);
    await db.insert(file).values({
      id: cleanupFileId,
      bucket: 'test-bucket',
      objectKey: `quests/v2/${hirerId}/pending.png`,
      contentType: 'image/png',
      sizeBytes: 3,
      uploadedByUserId: hirerId,
      deletedAt: new Date(testNow.getTime() - 1),
    });
    const deleteObject = spyOn(questV2Storage, 'delete')
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockResolvedValue();

    await runQuestLifecycleWorker({
      clock: { now: () => testNow },
      autoApprove: async () => [],
    });

    const [pending] = await db
      .select({ objectDeletedAt: file.objectDeletedAt })
      .from(file)
      .where(eq(file.id, cleanupFileId));
    expect(pending?.objectDeletedAt).toBeNull();

    await runQuestLifecycleWorker({
      clock: { now: () => testNow },
      autoApprove: async () => [],
    });
    expect(deleteObject).toHaveBeenCalledTimes(2);
    const [cleaned] = await db
      .select({ objectDeletedAt: file.objectDeletedAt })
      .from(file)
      .where(eq(file.id, cleanupFileId));
    expect(cleaned?.objectDeletedAt).not.toBeNull();
  });
});
