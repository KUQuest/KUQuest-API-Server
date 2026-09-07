import { db } from '@/database/client';
import {
  quest,
  questApiVersion,
  questAssignment,
  questV2ReviewCommand,
  review,
} from '@/database/schema/quest.schema';

import { and, eq } from 'drizzle-orm';

import { isTerminalQuestStatus } from './quest.contract';
import type { QuestStatus } from './quest.contract';
import type { QuestTransaction } from './quest-work-chat.port';

import type {
  QuestV2ReviewCreateInput,
  QuestV2ReviewUpdateInput,
} from './quest-review-v2.schema';

type ReviewCreateInput = QuestV2ReviewCreateInput;
type ReviewUpdateInput = QuestV2ReviewUpdateInput;

export type QuestV2ReviewRow = {
  id: string;
  questId: string;
  reviewerId: string;
  revieweeId: string;
  rating: number;
  comment: string | null;
  createdAt: Date;
  updatedAt: Date;
  replayed?: boolean;
};

type ReviewOutcomeCode =
  | 'already-exists'
  | 'conflict'
  | 'idempotency-in-progress'
  | 'idempotency-key-reused'
  | 'idempotency-unavailable'
  | 'invalid-comment'
  | 'invalid-idempotency-key'
  | 'invalid-rating'
  | 'not-authorized'
  | 'not-found'
  | 'not-terminal'
  | 'review-not-found'
  | 'reviewee-required'
  | 'window-expired';

export type QuestV2ReviewOutcome =
  | QuestV2ReviewRow
  | { outcome: ReviewOutcomeCode };

const reviewFields = {
  id: review.id,
  questId: review.questId,
  reviewerId: review.reviewerId,
  revieweeId: review.revieweeId,
  rating: review.rating,
  comment: review.comment,
  createdAt: review.createdAt,
  updatedAt: review.updatedAt,
};

const commandFields = {
  id: questV2ReviewCommand.id,
  requestHash: questV2ReviewCommand.requestHash,
  resourceId: questV2ReviewCommand.resourceId,
  resultData: questV2ReviewCommand.resultData,
  processingStatus: questV2ReviewCommand.processingStatus,
};

const reviewOutcomeCodes: readonly ReviewOutcomeCode[] = [
  'already-exists',
  'conflict',
  'idempotency-in-progress',
  'idempotency-key-reused',
  'idempotency-unavailable',
  'invalid-comment',
  'invalid-idempotency-key',
  'invalid-rating',
  'not-authorized',
  'not-found',
  'not-terminal',
  'review-not-found',
  'reviewee-required',
  'window-expired',
];

type QuestRow = {
  hirerId: string;
  questStatus: QuestStatus;
  updatedAt: Date;
};

type ReviewCommandRecord = {
  id: string;
  requestHash: string;
  resourceId: string | null;
  resultData: unknown;
  processingStatus: string;
};

type IdempotencyAcquireResult =
  | { created: true; record: ReviewCommandRecord }
  | { created: false; record: ReviewCommandRecord }
  | { outcome: Extract<ReviewOutcomeCode, `idempotency-${string}`> };

const reviewOperationScope = 'quest.v2.rating-review';
export const questV2ReviewOperationScope = reviewOperationScope;

const createReviewPath = '/api/v2/quests/:questId/reviews';
const updateReviewPath = '/api/v2/quests/:questId/reviews/:reviewId';

const sha256Json = async (value: object): Promise<string> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
};

const reviewDeadline = (terminalAt: Date): Date =>
  new Date(terminalAt.getTime() + 7 * 24 * 60 * 60 * 1000);

const isValidRating = (rating: number): boolean =>
  Number.isInteger(rating) && rating >= 1 && rating <= 5;

const normalizeComment = (
  comment: string | undefined,
): { value: string | null } | { outcome: 'invalid-comment' } => {
  if (comment === undefined) return { value: null };
  const value = comment.trim();
  return value.length > 0 && value.length <= 1000
    ? { value }
    : { outcome: 'invalid-comment' };
};

const lockQuest = async (
  transaction: QuestTransaction,
  questId: string,
): Promise<QuestRow | undefined> => {
  const [current] = await transaction
    .select({
      hirerId: quest.hirerId,
      questStatus: quest.questStatus,
      updatedAt: quest.updatedAt,
    })
    .from(quest)
    .where(and(eq(quest.id, questId), eq(quest.apiVersion, questApiVersion.v2)))
    .limit(1)
    .for('update');
  return current;
};

const acquireIdempotency = async (
  transaction: QuestTransaction,
  memberId: string,
  questId: string,
  operation: string,
  key: string,
  requestHash: string,
  now: Date,
): Promise<IdempotencyAcquireResult> => {
  const [created] = await transaction
    .insert(questV2ReviewCommand)
    .values({
      key,
      questId,
      principalUserId: memberId,
      operation,
      requestHash,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    })
    .onConflictDoNothing({ target: questV2ReviewCommand.key })
    .returning(commandFields);
  if (created) return { created: true, record: created };

  const [existing] = await transaction
    .select(commandFields)
    .from(questV2ReviewCommand)
    .where(eq(questV2ReviewCommand.key, key))
    .limit(1)
    .for('update');
  if (!existing) return { outcome: 'idempotency-unavailable' };
  if (existing.requestHash !== requestHash) return { outcome: 'idempotency-key-reused' };
  if (existing.processingStatus === 'COMPLETED') {
    return { created: false, record: existing };
  }
  return { outcome: 'idempotency-in-progress' };
};

const completeIdempotency = async (
  transaction: QuestTransaction,
  commandId: string,
  resourceId: string | null,
  resultData: object,
  now: Date,
): Promise<void> => {
  await transaction
    .update(questV2ReviewCommand)
    .set({
      resourceId,
      resultData,
      processingStatus: 'COMPLETED',
      completedAt: now,
    })
    .where(eq(questV2ReviewCommand.id, commandId));
};

const reviewSnapshot = (row: QuestV2ReviewRow) => ({
  id: row.id,
  questId: row.questId,
  reviewerId: row.reviewerId,
  revieweeId: row.revieweeId,
  rating: row.rating,
  comment: row.comment,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const dateFromSnapshot = (value: unknown): Date | undefined => {
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

const reviewFromSnapshot = (value: unknown): QuestV2ReviewRow | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const snapshot = value as Partial<QuestV2ReviewRow>;
  const createdAt = dateFromSnapshot(snapshot.createdAt);
  const updatedAt = dateFromSnapshot(snapshot.updatedAt);
  if (
    typeof snapshot.id !== 'string' ||
    typeof snapshot.questId !== 'string' ||
    typeof snapshot.reviewerId !== 'string' ||
    typeof snapshot.revieweeId !== 'string' ||
    typeof snapshot.rating !== 'number' ||
    !isValidRating(snapshot.rating) ||
    (snapshot.comment !== null && typeof snapshot.comment !== 'string') ||
    !createdAt ||
    !updatedAt
  ) return undefined;
  return {
    id: snapshot.id,
    questId: snapshot.questId,
    reviewerId: snapshot.reviewerId,
    revieweeId: snapshot.revieweeId,
    rating: snapshot.rating,
    comment: snapshot.comment ?? null,
    createdAt,
    updatedAt,
  };
};

const outcomeFromSnapshot = (value: unknown): { outcome: ReviewOutcomeCode } | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const outcome = (value as Record<string, unknown>).outcome;
  return typeof outcome === 'string' && reviewOutcomeCodes.includes(outcome as ReviewOutcomeCode)
    ? { outcome: outcome as ReviewOutcomeCode }
    : undefined;
};

const replayReview = (record: ReviewCommandRecord): QuestV2ReviewOutcome => {
  const row = reviewFromSnapshot(record.resultData);
  if (row) return { ...row, replayed: true };
  return outcomeFromSnapshot(record.resultData) ?? { outcome: 'idempotency-unavailable' };
};

const commandFailure = async (
  transaction: QuestTransaction,
  commandId: string,
  outcome: ReviewOutcomeCode,
  now: Date,
): Promise<{ outcome: ReviewOutcomeCode }> => {
  await completeIdempotency(transaction, commandId, null, { outcome }, now);
  return { outcome };
};

const reviewRequestHash = (
  memberId: string,
  operation: 'create' | 'update',
  questId: string,
  reviewId: string | null,
  input: ReviewCreateInput | ReviewUpdateInput,
): Promise<string> => sha256Json({
  authenticatedMemberId: memberId,
  operation: `${reviewOperationScope}.${operation}`,
  path: operation === 'create' ? createReviewPath : updateReviewPath,
  questId,
  reviewId,
  body: operation === 'create'
    ? {
        revieweeId: (input as ReviewCreateInput).revieweeId ?? null,
        rating: (input as ReviewCreateInput).rating,
        comment: (input as ReviewCreateInput).comment?.trim() ?? null,
      }
    : {
        rating: (input as ReviewUpdateInput).rating ?? null,
        comment: (input as ReviewUpdateInput).comment?.trim() ?? null,
      },
});

const assignmentExists = async (
  transaction: QuestTransaction,
  questId: string,
  workerId: string,
): Promise<boolean> => {
  const [assignment] = await transaction
    .select({ id: questAssignment.id })
    .from(questAssignment)
    .where(and(eq(questAssignment.questId, questId), eq(questAssignment.workerId, workerId)))
    .limit(1)
    .for('update');
  return Boolean(assignment);
};

const revieweeForCreate = async (
  transaction: QuestTransaction,
  current: QuestRow,
  questId: string,
  reviewerId: string,
  requestedRevieweeId: string | undefined,
): Promise<{ revieweeId: string } | { outcome: 'not-authorized' | 'reviewee-required' }> => {
  if (reviewerId === current.hirerId) {
    if (!requestedRevieweeId) return { outcome: 'reviewee-required' };
    if (
      requestedRevieweeId === current.hirerId ||
      !(await assignmentExists(transaction, questId, requestedRevieweeId))
    ) return { outcome: 'not-authorized' };
    return { revieweeId: requestedRevieweeId };
  }

  if (!(await assignmentExists(transaction, questId, reviewerId))) {
    return { outcome: 'not-authorized' };
  }
  if (requestedRevieweeId !== undefined && requestedRevieweeId !== current.hirerId) {
    return { outcome: 'not-authorized' };
  }
  return { revieweeId: current.hirerId };
};

const existingReview = async (
  transaction: QuestTransaction,
  questId: string,
  reviewId: string,
) => (await transaction
  .select(reviewFields)
  .from(review)
  .where(and(eq(review.id, reviewId), eq(review.questId, questId)))
  .limit(1)
  .for('update'))[0];

const isValidReviewPair = async (
  transaction: QuestTransaction,
  current: QuestRow,
  questId: string,
  reviewerId: string,
  revieweeId: string,
): Promise<boolean> => {
  if (reviewerId === current.hirerId) {
    return revieweeId !== current.hirerId && await assignmentExists(transaction, questId, revieweeId);
  }
  return revieweeId === current.hirerId && await assignmentExists(transaction, questId, reviewerId);
};

const isReviewable = (current: QuestRow): boolean =>
  isTerminalQuestStatus(current.questStatus);

export const createQuestV2Review = async (
  reviewerId: string,
  questId: string,
  input: ReviewCreateInput,
  rawCommandId: string,
  now = new Date(),
): Promise<QuestV2ReviewOutcome> => {
  const commandId = rawCommandId.trim();
  if (commandId.length === 0 || commandId.length > 200) {
    return { outcome: 'invalid-idempotency-key' };
  }
  const requestHash = await reviewRequestHash(reviewerId, 'create', questId, null, input);

  return db.transaction(async (transaction) => {
    const current = await lockQuest(transaction, questId);
    if (!current) return { outcome: 'not-found' };

    const idempotency = await acquireIdempotency(
      transaction,
      reviewerId,
      questId,
      `${reviewOperationScope}.create`,
      commandId,
      requestHash,
      now,
    );
    if ('outcome' in idempotency) return idempotency;
    if (!idempotency.created) return replayReview(idempotency.record);

    const fail = (outcome: ReviewOutcomeCode) =>
      commandFailure(transaction, idempotency.record.id, outcome, now);

    if (!isReviewable(current)) return fail('not-terminal');
    if (!isValidRating(input.rating)) return fail('invalid-rating');
    const comment = normalizeComment(input.comment);
    if ('outcome' in comment) return fail(comment.outcome);

    const reviewee = await revieweeForCreate(
      transaction,
      current,
      questId,
      reviewerId,
      input.revieweeId,
    );
    if ('outcome' in reviewee) return fail(reviewee.outcome);

    const existing = await transaction
      .select({ id: review.id })
      .from(review)
      .where(and(
        eq(review.questId, questId),
        eq(review.reviewerId, reviewerId),
        eq(review.revieweeId, reviewee.revieweeId),
      ))
      .limit(1)
      .for('update');
    if (existing[0]) return fail('already-exists');
    if (now.getTime() > reviewDeadline(current.updatedAt).getTime()) return fail('window-expired');

    const [created] = await transaction
      .insert(review)
      .values({
        questId,
        reviewerId,
        revieweeId: reviewee.revieweeId,
        rating: input.rating,
        comment: comment.value,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [review.questId, review.reviewerId, review.revieweeId],
      })
      .returning(reviewFields);
    if (!created) return fail('conflict');

    await completeIdempotency(
      transaction,
      idempotency.record.id,
      created.id,
      reviewSnapshot(created),
      now,
    );
    return created;
  });
};

export const updateQuestV2Review = async (
  reviewerId: string,
  questId: string,
  reviewId: string,
  input: ReviewUpdateInput,
  rawCommandId: string,
  now = new Date(),
): Promise<QuestV2ReviewOutcome> => {
  const commandId = rawCommandId.trim();
  if (commandId.length === 0 || commandId.length > 200) {
    return { outcome: 'invalid-idempotency-key' };
  }
  const requestHash = await reviewRequestHash(reviewerId, 'update', questId, reviewId, input);

  return db.transaction(async (transaction) => {
    const current = await lockQuest(transaction, questId);
    if (!current) return { outcome: 'not-found' };

    const idempotency = await acquireIdempotency(
      transaction,
      reviewerId,
      questId,
      `${reviewOperationScope}.update`,
      commandId,
      requestHash,
      now,
    );
    if ('outcome' in idempotency) return idempotency;
    if (!idempotency.created) return replayReview(idempotency.record);

    const fail = (outcome: ReviewOutcomeCode) =>
      commandFailure(transaction, idempotency.record.id, outcome, now);

    if (!isReviewable(current)) return fail('not-terminal');
    const currentReview = await existingReview(transaction, questId, reviewId);
    if (!currentReview) return fail('review-not-found');
    if (currentReview.reviewerId !== reviewerId) return fail('not-authorized');
    if (!(await isValidReviewPair(
      transaction,
      current,
      questId,
      currentReview.reviewerId,
      currentReview.revieweeId,
    ))) return fail('not-authorized');
    if (now.getTime() > reviewDeadline(current.updatedAt).getTime()) return fail('window-expired');

    const values: {
      rating?: number;
      comment?: string;
      updatedAt: Date;
    } = { updatedAt: now };
    if (input.rating !== undefined) {
      if (!isValidRating(input.rating)) return fail('invalid-rating');
      values.rating = input.rating;
    }
    if (input.comment !== undefined) {
      const comment = normalizeComment(input.comment);
      if ('outcome' in comment || comment.value === null) return fail('invalid-comment');
      values.comment = comment.value;
    }
    if (values.rating === undefined && values.comment === undefined) return fail('conflict');

    const [updated] = await transaction
      .update(review)
      .set(values)
      .where(eq(review.id, reviewId))
      .returning(reviewFields);
    if (!updated) return fail('conflict');

    await completeIdempotency(
      transaction,
      idempotency.record.id,
      updated.id,
      reviewSnapshot(updated),
      now,
    );
    return updated;
  });
};
