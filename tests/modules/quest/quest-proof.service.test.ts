import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { proofSubmission, quest, questAssignment } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { autoApproveDueProofs, reviewProof } from '@/modules/quest/quest-proof.service';

import { randomUUID } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

const hirerId = randomUUID();
const workerId = randomUUID();
const secondWorkerId = randomUUID();
const tagId = randomUUID();
const now = new Date('2026-08-27T12:00:00.000Z');
const questIds: string[] = [];
const proofIds: string[] = [];

const createFixture = async (status: 'QUEST_IN_PROGRESS' | 'QUEST_SUBMITTED' | 'QUEST_COMPLETED') => {
  const questId = randomUUID();
  const proofId = randomUUID();
  questIds.push(questId);
  proofIds.push(proofId);
  await db.insert(quest).values({
    id: questId,
    hirerId,
    title: 'Proof lifecycle test',
    condition: 'Done',
    mode: 'NO_CANDIDATE',
    participation: 'SOLO',
    questStatus: status,
    rewardSatang: 100,
    tagId,
    startTime: new Date('2026-08-27T08:00:00.000Z'),
  });
  await db.insert(questAssignment).values({ questId, workerId, assignmentStatus: 'ASSIGNMENT_ACTIVE' });
  await db.insert(proofSubmission).values({ id: proofId, questId, workerId, submittedByUserId: workerId, content: 'Done', submittedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000) });
  return { questId, proofId };
};

beforeAll(async () => {
  try {
    await sql`select 1`;
  } catch (cause) {
    throw new Error('These tests need PostgreSQL. Start the local database first.', { cause });
  }
  await db.insert(authUser).values([
    { id: hirerId, email: `${hirerId}@ku.th`, firstName: 'Hirer', lastName: 'Test' },
    { id: workerId, email: `${workerId}@ku.th`, firstName: 'Worker', lastName: 'Test' },
    { id: secondWorkerId, email: `${secondWorkerId}@ku.th`, firstName: 'Second', lastName: 'Worker' },
  ]);
  await db.insert(tag).values({ id: tagId, name: `Proof test ${tagId}` });
});

afterAll(async () => {
  await db.delete(quest).where(inArray(quest.id, questIds));
  await db.delete(tag).where(eq(tag.id, tagId));
  await db.delete(authUser).where(inArray(authUser.id, [hirerId, workerId, secondWorkerId]));
});

describe('Quest Proof lifecycle gates', () => {
  it('does not review a pending proof while the Quest is in progress or terminal', async () => {
    const inProgress = await createFixture('QUEST_IN_PROGRESS');
    const terminal = await createFixture('QUEST_COMPLETED');
    expect((await reviewProof(hirerId, inProgress.questId, inProgress.proofId, 'PROOF_APPROVED', null, now))).toEqual({ outcome: 'invalid-review-state' });
    expect((await reviewProof(hirerId, terminal.questId, terminal.proofId, 'PROOF_APPROVED', null, now))).toEqual({ outcome: 'invalid-review-state' });
    const rows = await db.select({ status: proofSubmission.submissionStatus }).from(proofSubmission).where(inArray(proofSubmission.id, [inProgress.proofId, terminal.proofId]));
    expect(rows.every(({ status }) => status === 'PROOF_PENDING')).toBe(true);
  });

  it('auto-approves only overdue proofs in the review lifecycle', async () => {
    const submitted = await createFixture('QUEST_SUBMITTED');
    const inProgress = await createFixture('QUEST_IN_PROGRESS');
    const terminal = await createFixture('QUEST_COMPLETED');
    const approved = await autoApproveDueProofs(now);
    expect(approved).toContain(submitted.proofId);
    expect(approved).not.toContain(inProgress.proofId);
    expect(approved).not.toContain(terminal.proofId);
    const rows = await db.select({ id: proofSubmission.id, status: proofSubmission.submissionStatus }).from(proofSubmission).where(inArray(proofSubmission.id, [submitted.proofId, inProgress.proofId, terminal.proofId]));
    expect(rows.find(({ id }) => id === submitted.proofId)?.status).toBe('PROOF_AUTO_APPROVED');
    expect(rows.filter(({ id }) => id !== submitted.proofId).every(({ status }) => status === 'PROOF_PENDING')).toBe(true);
  });

  it('uses one hour for a Candidate proof review window', async () => {
    const candidateQuestId = randomUUID();
    const candidateProofId = randomUUID();
    questIds.push(candidateQuestId);
    proofIds.push(candidateProofId);
    await db.insert(quest).values({
      id: candidateQuestId,
      hirerId,
      title: 'Candidate review window',
      condition: 'Done',
      mode: 'CANDIDATE',
      participation: 'GROUP',
      questStatus: 'QUEST_SUBMITTED',
      rewardSatang: 100,
      headcount: 2,
      tagId,
      startTime: new Date('2026-08-27T08:00:00.000Z'),
    });
    await db.insert(questAssignment).values([
      { questId: candidateQuestId, workerId, assignmentStatus: 'ASSIGNMENT_ACTIVE' },
      { questId: candidateQuestId, workerId: secondWorkerId, assignmentStatus: 'ASSIGNMENT_ACTIVE' },
    ]);
    await db.insert(proofSubmission).values({
      id: candidateProofId,
      questId: candidateQuestId,
      workerId,
      submittedByUserId: workerId,
      content: 'Candidate work',
      submittedAt: new Date(now.getTime() - 60 * 60 * 1000 - 1),
    });

    expect(await autoApproveDueProofs(now)).toContain(candidateProofId);
  });
});
