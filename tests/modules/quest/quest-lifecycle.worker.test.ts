import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import {
  proofSubmission,
  quest,
  questAssignment,
  questTeam,
  questTeamInvitation,
} from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { runQuestLifecycleWorker } from '@/modules/quest/quest-lifecycle.worker';

import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

const hirerId = crypto.randomUUID();
const workerId = crypto.randomUUID();
const tagId = crypto.randomUUID();
const testNow = new Date('2026-08-27T12:00:00.000Z');
const questIds: string[] = [];
const teamIds: string[] = [];
const invitationIds: string[] = [];

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

const addAssignment = async (questId: string) => {
  await db.insert(questAssignment).values({ questId, workerId, assignmentStatus: 'ASSIGNMENT_ACTIVE' });
};

beforeAll(async () => {
  try {
    await sql`select 1`;
  } catch (cause) {
    throw new Error('These tests need PostgreSQL. Start the local database first.', { cause });
  }
  await db.insert(authUser).values([
    { id: hirerId, email: `${hirerId}@ku.th`, firstName: 'Lifecycle', lastName: 'Hirer' },
    { id: workerId, email: `${workerId}@ku.th`, firstName: 'Lifecycle', lastName: 'Worker' },
  ]);
  await db.insert(tag).values({ id: tagId, name: `Lifecycle ${tagId}` });
});

afterAll(async () => {
  await db.delete(quest).where(inArray(quest.id, questIds));
  await db.delete(questTeam).where(inArray(questTeam.id, teamIds));
  await db.delete(questTeamInvitation).where(inArray(questTeamInvitation.id, invitationIds));
  await db.delete(tag).where(eq(tag.id, tagId));
  await db.delete(authUser).where(inArray(authUser.id, [hirerId, workerId]));
});

describe('Quest lifecycle worker', () => {
  it('starts only due assigned Quests with one fake-time instant for all active Assignments', async () => {
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

    const result = await runQuestLifecycleWorker({
      clock: { now: () => testNow },
      autoApprove: async () => [],
    });

    expect(result.startedQuestIds).toContain(dueId);
    const rows = await db.select({ id: quest.id, status: quest.questStatus, startedAt: questAssignment.startedAt })
      .from(quest).leftJoin(questAssignment, eq(questAssignment.questId, quest.id))
      .where(inArray(quest.id, [dueId, futureId]));
    expect(rows.find((row) => row.id === dueId)?.status).toBe('QUEST_IN_PROGRESS');
    expect(rows.find((row) => row.id === dueId)?.startedAt?.getTime()).toBe(testNow.getTime());
    expect(rows.find((row) => row.id === futureId)?.status).toBe('QUEST_ASSIGNED');
  });

  it('is safe to retry and run concurrently', async () => {
    const questId = await createQuest({ questStatus: 'QUEST_ASSIGNED', startTime: new Date(testNow.getTime() - 1) });
    await addAssignment(questId);
    const options = { clock: { now: () => testNow }, autoApprove: async () => [] };
    const [first, second] = await Promise.all([runQuestLifecycleWorker(options), runQuestLifecycleWorker(options)]);
    expect(first.startedQuestIds.concat(second.startedQuestIds).filter((id) => id === questId).length).toBe(1);
    const [row] = await db.select({ status: quest.questStatus, startedAt: questAssignment.startedAt })
      .from(quest).innerJoin(questAssignment, eq(questAssignment.questId, quest.id)).where(eq(quest.id, questId));
    expect(row?.status).toBe('QUEST_IN_PROGRESS');
    expect(row?.startedAt?.getTime()).toBe(testNow.getTime());
  });

  it('disputes due Quests with missing proof or confirmation, but keeps a submitted proof path', async () => {
    const missingProofId = await createQuest({ dueAt: new Date(testNow.getTime() - 1) });
    const missingConfirmationId = await createQuest({ proofRequired: false, dueAt: new Date(testNow.getTime() - 1) });
    const submittedId = await createQuest({ questStatus: 'QUEST_SUBMITTED', dueAt: new Date(testNow.getTime() - 1) });
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

    const result = await runQuestLifecycleWorker({ clock: { now: () => testNow }, autoApprove: async () => [] });
    expect(result.disputedQuestIds).toEqual(expect.arrayContaining([missingProofId, missingConfirmationId]));
    const rows = await db.select({ id: quest.id, status: quest.questStatus }).from(quest).where(inArray(quest.id, [missingProofId, missingConfirmationId, submittedId]));
    expect(rows.find((row) => row.id === submittedId)?.status).toBe('QUEST_SUBMITTED');
  });

  it('expires only pending invitations and delegates proof auto-approval to its seam', async () => {
    const questId = await createQuest({ mode: 'CANDIDATE', participation: 'GROUP', questStatus: 'QUEST_OPEN', headcount: 1 });
    const teamId = crypto.randomUUID();
    teamIds.push(teamId);
    await db.insert(questTeam).values({ id: teamId, questId, leaderId: workerId, name: 'Lifecycle team' });
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
      autoApprove: async (now) => { receivedNow = now; return ['proof-id']; },
    });
    expect(receivedNow?.getTime()).toBe(testNow.getTime());
    expect(result.autoApprovedProofIds).toEqual(['proof-id']);
    const [invitation] = await db.select({ status: questTeamInvitation.invitationStatus, respondedAt: questTeamInvitation.respondedAt })
      .from(questTeamInvitation).where(and(eq(questTeamInvitation.id, invitationId), eq(questTeamInvitation.invitationStatus, 'INVITATION_EXPIRED')));
    expect(invitation?.respondedAt?.getTime()).toBe(testNow.getTime());
  });
});
