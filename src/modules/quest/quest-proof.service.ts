import type { StoredImage } from '@/shared/image-storage';
import { db } from '@/database/client';
import { file } from '@/database/schema/file.schema';
import {
  proofSubmission,
  proofSubmissionImage,
  quest,
  questApplication,
  questAssignment,
  questCompletionConfirmation,
  questTeam,
  questTeamMember,
} from '@/database/schema/quest.schema';

import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import { settleApprovedQuestInTransaction } from './quest-settlement.service';
import {
  assignmentStatus,
  questMode,
  questParticipation,
  questStatus,
  teamStatus,
} from './quest.contract';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type Owner = { workerId?: string; teamId?: string };
type QuestProofRow = {
  id: string;
  questId: string;
  workerId: string | null;
  teamId: string | null;
  submittedByUserId: string;
  content: string;
  submissionStatus: string;
  reviewNote: string | null;
  submittedAt: Date;
  reviewedAt: Date | null;
  images: string[];
};

export type ProofOutcome =
  | { outcome: 'not-found' | 'not-allowed' | 'invalid-state' | 'already-submitted' | 'files-invalid' | 'proof-required' | 'no-rework' | 'disputed' }
  | { proof: QuestProofRow };
export type ReviewOutcome =
  | { outcome: 'not-found' | 'not-authorized' | 'not-pending' | 'invalid-review-state' | 'disputed' }
  | { proof: QuestProofRow; questStatus: string };

const ownerCondition = (owner: Owner) => owner.workerId
  ? eq(proofSubmission.workerId, owner.workerId)
  : eq(proofSubmission.teamId, owner.teamId!);

const ownerConfirmationCondition = (owner: Owner) => owner.workerId
  ? eq(questCompletionConfirmation.workerId, owner.workerId)
  : eq(questCompletionConfirmation.teamId, owner.teamId!);

const lockQuest = async (tx: Tx, questId: string) => {
  const [row] = await tx.select({
    id: quest.id,
    hirerId: quest.hirerId,
    mode: quest.mode,
    participation: quest.participation,
    questStatus: quest.questStatus,
    proofRequired: quest.proofRequired,
  }).from(quest).where(eq(quest.id, questId)).limit(1).for('update');
  return row;
};

const findOwner = async (tx: Tx, questId: string, userId: string, lock = true): Promise<Owner | undefined> => {
  const assignments = tx.select({ workerId: questAssignment.workerId })
    .from(questAssignment)
    .where(and(eq(questAssignment.questId, questId), eq(questAssignment.workerId, userId), eq(questAssignment.assignmentStatus, assignmentStatus.active)))
    .limit(1);
  const assignment = (lock ? await assignments.for('update') : await assignments)[0];
  if (!assignment) return undefined;

  const [current] = await tx.select({ mode: quest.mode, participation: quest.participation })
    .from(quest).where(eq(quest.id, questId)).limit(1);
  if (current?.mode === questMode.candidate && current.participation === questParticipation.group) {
    const teams = tx.select({ id: questTeam.id })
      .from(questTeamMember)
      .innerJoin(questTeam, eq(questTeamMember.teamId, questTeam.id))
      .where(and(eq(questTeam.questId, questId), eq(questTeamMember.userId, userId), eq(questTeam.teamStatus, teamStatus.selected)))
      .limit(1);
    const team = (lock ? await teams.for('update') : await teams)[0];
    if (!team) return undefined;
    return { teamId: team.id };
  }
  if (current?.mode === questMode.candidate) {
    const [application] = await tx.select({ id: questApplication.id }).from(questApplication)
      .where(and(eq(questApplication.questId, questId), eq(questApplication.workerId, userId), eq(questApplication.applicationStatus, 'APPLICATION_SELECTED')))
      .limit(1).for('update');
    if (!application) return undefined;
  }
  return { workerId: userId };
};

const fileIdsForProof = async (tx: Tx, userId: string, fileIds: string[]) => {
  if (fileIds.length > 3 || new Set(fileIds).size !== fileIds.length) return false;
  if (fileIds.length === 0) return true;
  const rows = await tx.select({ id: file.id }).from(file).where(and(
    inArray(file.id, fileIds),
    eq(file.uploadedByUserId, userId),
    isNull(file.deletedAt),
  )).for('update');
  return rows.length === fileIds.length;
};

const loadProof = async (tx: Tx, id: string): Promise<QuestProofRow | undefined> => {
  const [row] = await tx.select({
    id: proofSubmission.id,
    questId: proofSubmission.questId,
    workerId: proofSubmission.workerId,
    teamId: proofSubmission.teamId,
    submittedByUserId: proofSubmission.submittedByUserId,
    content: proofSubmission.content,
    submissionStatus: proofSubmission.submissionStatus,
    reviewNote: proofSubmission.reviewNote,
    submittedAt: proofSubmission.submittedAt,
    reviewedAt: proofSubmission.reviewedAt,
  }).from(proofSubmission).where(eq(proofSubmission.id, id)).limit(1);
  if (!row) return undefined;
  const images = await tx.select({ fileId: proofSubmissionImage.fileId }).from(proofSubmissionImage)
    .where(eq(proofSubmissionImage.proofSubmissionId, id)).orderBy(asc(proofSubmissionImage.position));
  return { ...row, images: images.map((image) => image.fileId) };
};

const hasOppositeOwnerSubmission = async (tx: Tx, questId: string, owner: Owner) => {
  const [row] = await tx.select({ id: proofSubmission.id }).from(proofSubmission).where(and(
    eq(proofSubmission.questId, questId),
    owner.teamId ? sql`${proofSubmission.workerId} IS NOT NULL` : sql`${proofSubmission.teamId} IS NOT NULL`,
  )).limit(1);
  return Boolean(row);
};

const ownerHasSubmission = async (tx: Tx, questId: string, owner: Owner, statuses: string[]) => {
  const rows = await tx.select({ id: proofSubmission.id, submissionStatus: proofSubmission.submissionStatus })
    .from(proofSubmission).where(and(eq(proofSubmission.questId, questId), ownerCondition(owner), inArray(proofSubmission.submissionStatus, statuses)));
  return rows.length > 0;
};

const ownerCount = async (tx: Tx, questId: string, owner: Owner, status: string) => {
  const [row] = await tx.select({ count: sql<number>`count(*)` }).from(proofSubmission)
    .where(and(eq(proofSubmission.questId, questId), ownerCondition(owner), eq(proofSubmission.submissionStatus, status)));
  return Number(row?.count ?? 0);
};

const sameOwner = (left: Owner, right: Owner) => left.workerId === right.workerId && left.teamId === right.teamId;
const isReviewLifecycle = (status: string) => status === questStatus.submitted || status === questStatus.rework;

const latestRejectedOwner = async (tx: Tx, questId: string): Promise<Owner | undefined> => {
  const [row] = await tx.select({ workerId: proofSubmission.workerId, teamId: proofSubmission.teamId })
    .from(proofSubmission).where(and(eq(proofSubmission.questId, questId), eq(proofSubmission.submissionStatus, 'PROOF_REJECTED')))
    .orderBy(sql`${proofSubmission.reviewedAt} DESC NULLS LAST`, sql`${proofSubmission.id} DESC`).limit(1);
  return row?.workerId ? { workerId: row.workerId } : row?.teamId ? { teamId: row.teamId } : undefined;
};

const ownersForQuest = async (tx: Tx, current: { id: string; mode: string; participation: string }): Promise<Owner[]> => {
  if (current.mode === questMode.candidate && current.participation === questParticipation.group) {
    const [team] = await tx.select({ id: questTeam.id }).from(questTeam)
      .where(and(eq(questTeam.questId, current.id), eq(questTeam.teamStatus, teamStatus.selected))).limit(1).for('update');
    return team ? [{ teamId: team.id }] : [];
  }
  const assignments = await tx.select({ workerId: questAssignment.workerId }).from(questAssignment)
    .where(and(eq(questAssignment.questId, current.id), eq(questAssignment.assignmentStatus, assignmentStatus.active)))
    .for('update');
  return assignments.map(({ workerId }) => ({ workerId }));
};

const allObligationsSubmitted = async (tx: Tx, current: { id: string; mode: string; participation: string; proofRequired: boolean }) => {
  const owners = await ownersForQuest(tx, current);
  if (owners.length === 0) return false;
  if (!current.proofRequired) {
    const confirmations = await tx.select({ workerId: questCompletionConfirmation.workerId, teamId: questCompletionConfirmation.teamId })
      .from(questCompletionConfirmation).where(eq(questCompletionConfirmation.questId, current.id));
    return owners.every((owner) => confirmations.some((confirmation) => owner.workerId === confirmation.workerId && owner.teamId === confirmation.teamId));
  }
  return Promise.all(owners.map((owner) => ownerHasSubmission(tx, current.id, owner, ['PROOF_PENDING', 'PROOF_APPROVED', 'PROOF_AUTO_APPROVED'])))
    .then((values) => values.every(Boolean));
};

const allObligationsApproved = async (tx: Tx, current: { id: string; mode: string; participation: string; proofRequired: boolean }) => {
  if (!current.proofRequired) return false;
  const owners = await ownersForQuest(tx, current);
  if (owners.length === 0) return false;
  return Promise.all(owners.map((owner) => ownerHasSubmission(tx, current.id, owner, ['PROOF_APPROVED', 'PROOF_AUTO_APPROVED'])))
    .then((values) => values.every(Boolean));
};

const moveIfSubmitted = async (tx: Tx, current: { id: string; questStatus: string; mode: string; participation: string; proofRequired: boolean }, now: Date) => {
  if (await allObligationsSubmitted(tx, current)) {
    const [updated] = await tx.update(quest).set({ questStatus: questStatus.submitted, updatedAt: now })
      .where(and(eq(quest.id, current.id), eq(quest.questStatus, current.questStatus as never))).returning({ id: quest.id });
    return Boolean(updated);
  }
  return false;
};

const insertProof = async (tx: Tx, input: { questId: string; userId: string; owner: Owner; content: string; fileIds: string[]; submittedAt: Date }) => {
  const [created] = await tx.insert(proofSubmission).values({
    questId: input.questId,
    workerId: input.owner.workerId,
    teamId: input.owner.teamId,
    submittedByUserId: input.userId,
    content: input.content,
    submittedAt: input.submittedAt,
  }).returning({ id: proofSubmission.id });
  if (!created) throw new Error('Proof Submission could not be created');
  if (input.fileIds.length > 0) await tx.insert(proofSubmissionImage).values(input.fileIds.map((fileId, position) => ({ proofSubmissionId: created.id, fileId, position })));
  const proof = await loadProof(tx, created.id);
  if (!proof) throw new Error('Proof Submission could not be loaded');
  return proof;
};

export const submitProof = async (userId: string, questId: string, content: string, fileIds: string[] = [], now = new Date(), storedImages: StoredImage[] = []): Promise<ProofOutcome> => db.transaction(async (tx) => {
  const current = await lockQuest(tx, questId);
  if (!current) return { outcome: 'not-found' };
  if (current.hirerId === userId) return { outcome: 'not-allowed' };
  if (current.questStatus !== questStatus.inProgress && current.questStatus !== questStatus.rework) return { outcome: 'invalid-state' };
  if (!current.proofRequired) return { outcome: 'proof-required' };
  const owner = await findOwner(tx, questId, userId);
  if (!owner) return { outcome: 'not-allowed' };
  const rejected = await ownerCount(tx, questId, owner, 'PROOF_REJECTED');
  if (rejected > 0 && current.questStatus !== questStatus.rework) return { outcome: 'no-rework' };
  if (current.questStatus === questStatus.rework) {
    const rejectedOwner = await latestRejectedOwner(tx, questId);
    if (!rejectedOwner || !sameOwner(rejectedOwner, owner)) return { outcome: 'not-allowed' };
  }
  let persistedFileIds = fileIds;
  if (storedImages.length > 0) {
    if (storedImages.length > 3) return { outcome: 'files-invalid' };
    const createdFiles = await tx.insert(file).values(storedImages.map((image) => ({ ...image, uploadedByUserId: userId }))).returning({ id: file.id });
    persistedFileIds = createdFiles.map(({ id }) => id);
  }
  if (!(await fileIdsForProof(tx, userId, persistedFileIds))) return { outcome: 'files-invalid' };
  if (await hasOppositeOwnerSubmission(tx, questId, owner)) return { outcome: 'already-submitted' };
  if (await ownerHasSubmission(tx, questId, owner, ['PROOF_PENDING', 'PROOF_APPROVED', 'PROOF_AUTO_APPROVED'])) return { outcome: 'already-submitted' };
  if (current.mode === questMode.noCandidate && rejected > 0) return { outcome: 'no-rework' };
  const proof = await insertProof(tx, { questId, userId, owner, content, fileIds: persistedFileIds, submittedAt: now });
  await moveIfSubmitted(tx, current, now);
  return { proof };
});

export const confirmProofFreeWork = async (userId: string, questId: string, now = new Date()): Promise<{ outcome: string } | { confirmed: boolean; questStatus: string }> => db.transaction(async (tx) => {
  const current = await lockQuest(tx, questId);
  if (!current) return { outcome: 'not-found' };
  if (current.proofRequired) return { outcome: 'proof-required' };
  if (current.hirerId === userId) return { outcome: 'not-allowed' };
  if (current.questStatus !== questStatus.inProgress && current.questStatus !== questStatus.rework) return { outcome: 'invalid-state' };

  const owner = await findOwner(tx, questId, userId);
  if (!owner) return { outcome: 'not-allowed' };
  const [existing] = await tx.select({ id: questCompletionConfirmation.id }).from(questCompletionConfirmation)
    .where(and(eq(questCompletionConfirmation.questId, questId), ownerConfirmationCondition(owner))).limit(1).for('update');
  if (!existing) await tx.insert(questCompletionConfirmation).values({ questId, workerId: owner.workerId, teamId: owner.teamId, confirmedByUserId: userId, confirmedAt: now });
  await moveIfSubmitted(tx, current, now);
  const [updated] = await tx.select({ questStatus: quest.questStatus }).from(quest).where(eq(quest.id, questId));
  return { confirmed: true, questStatus: updated?.questStatus ?? current.questStatus };
});

export const reviewProof = async (hirerId: string, questId: string, proofId: string, decision: 'PROOF_APPROVED' | 'PROOF_REJECTED', note: string | null = null, now = new Date()): Promise<ReviewOutcome> => db.transaction(async (tx) => {
  const current = await lockQuest(tx, questId);
  if (!current) return { outcome: 'not-found' };
  if (current.hirerId !== hirerId) return { outcome: 'not-authorized' };
  if (!isReviewLifecycle(current.questStatus)) return { outcome: 'invalid-review-state' };
  const [proof] = await tx.select({ id: proofSubmission.id, workerId: proofSubmission.workerId, teamId: proofSubmission.teamId, submissionStatus: proofSubmission.submissionStatus })
    .from(proofSubmission)
    .innerJoin(quest, eq(proofSubmission.questId, quest.id))
    .where(and(
      eq(proofSubmission.id, proofId),
      eq(proofSubmission.questId, questId),
      inArray(quest.questStatus, [questStatus.submitted, questStatus.rework]),
    )).limit(1).for('update');
  if (!proof) return { outcome: 'not-found' };
  if (proof.submissionStatus !== 'PROOF_PENDING') return { outcome: 'not-pending' };
  const proofOwner: Owner | undefined = proof.workerId
    ? { workerId: proof.workerId }
    : proof.teamId
      ? { teamId: proof.teamId }
      : undefined;
  const validOwners = proofOwner && (await ownersForQuest(tx, current)).some((owner) => sameOwner(owner, proofOwner));
  if (!validOwners) return { outcome: 'not-found' };
  const status = decision;
  await tx.update(proofSubmission).set({ submissionStatus: status, reviewNote: note, reviewedAt: now }).where(eq(proofSubmission.id, proofId));
  if (decision === 'PROOF_REJECTED') {
    const owner = proofOwner!;
    const rejected = await ownerCount(tx, questId, owner, 'PROOF_REJECTED');
    let limit = 0;
    if (proof.teamId) {
      const [team] = await tx.select({ reworkLimit: questTeam.reworkLimit }).from(questTeam).where(eq(questTeam.id, proof.teamId)).limit(1).for('update');
      limit = team?.reworkLimit ?? 0;
    } else {
      const [application] = await tx.select({ reworkLimit: questApplication.reworkLimit }).from(questApplication).where(and(eq(questApplication.questId, questId), eq(questApplication.workerId, proof.workerId!))).limit(1).for('update');
      limit = application?.reworkLimit ?? 0;
    }
    if (current.mode === questMode.noCandidate || rejected > limit) {
      await tx.update(quest).set({ questStatus: questStatus.disputed, updatedAt: now }).where(eq(quest.id, questId));
      return { outcome: 'disputed' };
    }
    await tx.update(quest).set({ questStatus: questStatus.rework, updatedAt: now }).where(eq(quest.id, questId));
  } else if (await allObligationsApproved(tx, current)) {
    await tx.update(quest).set({ questStatus: questStatus.approved, updatedAt: now }).where(eq(quest.id, questId));
    await settleApprovedQuestInTransaction(tx, questId, hirerId, `quest-completion:${questId}`, now);
  }
  const updated = await loadProof(tx, proofId);
  return { proof: updated!, questStatus: (await tx.select({ questStatus: quest.questStatus }).from(quest).where(eq(quest.id, questId)))[0]!.questStatus };
});

export const listProofs = async (userId: string, questId: string) => {
  const rows = await db.select({
    id: proofSubmission.id,
    questId: proofSubmission.questId,
    workerId: proofSubmission.workerId,
    teamId: proofSubmission.teamId,
    submittedByUserId: proofSubmission.submittedByUserId,
    content: proofSubmission.content,
    submissionStatus: proofSubmission.submissionStatus,
    reviewNote: proofSubmission.reviewNote,
    submittedAt: proofSubmission.submittedAt,
    reviewedAt: proofSubmission.reviewedAt,
  }).from(proofSubmission).innerJoin(quest, eq(proofSubmission.questId, quest.id)).where(and(eq(proofSubmission.questId, questId), or(eq(quest.hirerId, userId), eq(proofSubmission.submittedByUserId, userId)))).orderBy(asc(proofSubmission.submittedAt));
  return Promise.all(rows.map(async (row) => ({ ...row, images: (await db.select({ fileId: proofSubmissionImage.fileId }).from(proofSubmissionImage).where(eq(proofSubmissionImage.proofSubmissionId, row.id)).orderBy(asc(proofSubmissionImage.position))).map(({ fileId }) => fileId) })));
};

const autoApproveDueProofFreeQuests = async (tx: Tx, now: Date) => {
  const candidates = await tx.select({ id: quest.id, hirerId: quest.hirerId })
    .from(quest)
    .where(and(
      eq(quest.proofRequired, false),
      eq(quest.questStatus, questStatus.submitted),
      sql`${quest.updatedAt} <= ${now.toISOString()}::timestamptz - interval '1 hour'`,
    ))
    .orderBy(asc(quest.updatedAt), asc(quest.id));

  for (const candidate of candidates) {
    const current = await lockQuest(tx, candidate.id);
    if (!current || current.proofRequired || current.questStatus !== questStatus.submitted) continue;
    if (!(await allObligationsSubmitted(tx, current))) continue;
    const [approvedQuest] = await tx.update(quest).set({ questStatus: questStatus.approved, updatedAt: now })
      .where(and(eq(quest.id, candidate.id), eq(quest.questStatus, questStatus.submitted)))
      .returning({ id: quest.id });
    if (approvedQuest) await settleApprovedQuestInTransaction(tx, candidate.id, candidate.hirerId, `quest-completion:${candidate.id}`, now);
  }
};

export const autoApproveDueProofs = async (now = new Date()): Promise<string[]> => db.transaction(async (tx) => {
  const candidates = await tx.select({ id: proofSubmission.id, questId: proofSubmission.questId, submittedAt: proofSubmission.submittedAt, mode: quest.mode })
    .from(proofSubmission).innerJoin(quest, eq(proofSubmission.questId, quest.id))
    .where(and(
      eq(proofSubmission.submissionStatus, 'PROOF_PENDING'),
      inArray(quest.questStatus, [questStatus.submitted, questStatus.rework]),
      sql`${proofSubmission.submittedAt} <= ${now.toISOString()}::timestamptz - interval '1 hour'`,
    ))
    .orderBy(asc(proofSubmission.submittedAt), asc(proofSubmission.id));
  const approved: string[] = [];
  for (const candidate of candidates) {
    const current = await lockQuest(tx, candidate.questId);
    if (!current || !isReviewLifecycle(current.questStatus)) continue;
    const [proof] = await tx.select({ id: proofSubmission.id, status: proofSubmission.submissionStatus }).from(proofSubmission)
      .innerJoin(quest, eq(proofSubmission.questId, quest.id))
      .where(and(
        eq(proofSubmission.id, candidate.id),
        inArray(quest.questStatus, [questStatus.submitted, questStatus.rework]),
      )).limit(1).for('update');
    if (!proof || proof.status !== 'PROOF_PENDING') continue;
    await tx.update(proofSubmission).set({ submissionStatus: 'PROOF_AUTO_APPROVED', reviewedAt: now }).where(and(eq(proofSubmission.id, candidate.id), eq(proofSubmission.submissionStatus, 'PROOF_PENDING')));
    approved.push(candidate.id);
    if (await allObligationsApproved(tx, current)) {
      const [approvedQuest] = await tx.update(quest).set({ questStatus: questStatus.approved, updatedAt: now }).where(and(eq(quest.id, current.id), inArray(quest.questStatus, [questStatus.submitted, questStatus.rework]))).returning({ id: quest.id });
      if (approvedQuest) await settleApprovedQuestInTransaction(tx, candidate.questId, current.hirerId, `quest-completion:${candidate.questId}`, now);
    }
  }
  await autoApproveDueProofFreeQuests(tx, now);
  return approved;
});

export const countRequiredConfirmations = async (questId: string) => {
  const rows = await db.select({ workerId: questCompletionConfirmation.workerId, teamId: questCompletionConfirmation.teamId })
    .from(questCompletionConfirmation).where(eq(questCompletionConfirmation.questId, questId));
  return rows.length;
};

/** Returns the progress of the proof-free completion obligations without changing state. */
export const getRequiredConfirmationCount = async (questId: string) => db.transaction(async (tx) => {
  const current = await lockQuest(tx, questId);
  if (!current) return undefined;
  const owners = await ownersForQuest(tx, current);
  const confirmed = await countRequiredConfirmationsInTransaction(tx, questId);
  return { confirmed, required: owners.length };
});

export const submitQuestProof = submitProof;
export const reviewQuestProof = reviewProof;
export const confirmQuestCompletion = confirmProofFreeWork;

const countRequiredConfirmationsInTransaction = async (tx: Tx, questId: string) => {
  const rows = await tx.select({ id: questCompletionConfirmation.id }).from(questCompletionConfirmation)
    .where(eq(questCompletionConfirmation.questId, questId));
  return rows.length;
};
