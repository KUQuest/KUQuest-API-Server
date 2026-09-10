import { db } from '@/database/client';
import { quest, questApiVersion, questAssignment, review } from '@/database/schema/quest.schema';

import { and, eq } from 'drizzle-orm';

import {
  runQuestCommand,
  sha256Json,
  type QuestCommandOutcomeCode,
  type QuestCommandWork,
} from './quest-command.service';
import { isTerminalQuestStatus } from './quest.contract';
import type { QuestStatus } from './quest.contract';
import type { QuestTransaction } from './quest-work-chat.port';

import type { QuestV2ReviewCreateInput, QuestV2ReviewUpdateInput } from './quest-review-v2.schema';

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
};

type ReviewBusinessOutcomeCode =
  | 'already-exists'
  | 'conflict'
  | 'invalid-comment'
  | 'invalid-rating'
  | 'not-authorized'
  | 'not-found'
  | 'not-terminal'
  | 'review-not-found'
  | 'reviewee-required'
  | 'window-expired';

type ReviewOutcomeCode = ReviewBusinessOutcomeCode | QuestCommandOutcomeCode;

export type QuestV2ReviewOutcome = QuestV2ReviewRow | { outcome: ReviewOutcomeCode };

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

type QuestRow = {
  hirerId: string;
  questStatus: QuestStatus;
  updatedAt: Date;
};

const reviewOperationScope = 'quest.v2.rating-review';
export const questV2ReviewOperationScope = reviewOperationScope;

const createReviewPath = '/api/v2/quests/:questId/reviews';
const updateReviewPath = '/api/v2/quests/:questId/reviews/:reviewId';

const reviewDeadline = (terminalAt: Date): Date =>
  new Date(terminalAt.getTime() + 7 * 24 * 60 * 60 * 1000);

const isValidRating = (rating: number): boolean =>
  Number.isInteger(rating) && rating >= 1 && rating <= 5;

const normalizeComment = (
  comment: string | undefined
): { value: string | null } | { outcome: 'invalid-comment' } => {
  if (comment === undefined) return { value: null };
  const value = comment.trim();
  return value.length > 0 && value.length <= 1000 ? { value } : { outcome: 'invalid-comment' };
};

const lockQuest = async (
  transaction: QuestTransaction,
  questId: string
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
  )
    return undefined;
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

const reviewRequestHash = (
  memberId: string,
  operation: 'create' | 'update',
  questId: string,
  reviewId: string | null,
  input: ReviewCreateInput | ReviewUpdateInput
): Promise<string> => {
  const body =
    operation === 'create'
      ? {
          revieweeId: (input as ReviewCreateInput).revieweeId ?? null,
          rating: (input as ReviewCreateInput).rating,
          comment: (input as ReviewCreateInput).comment?.trim() ?? null,
        }
      : {
          rating: (input as ReviewUpdateInput).rating ?? null,
          comment: (input as ReviewUpdateInput).comment?.trim() ?? null,
        };
  return sha256Json({
    authenticatedMemberId: memberId,
    operation: `${reviewOperationScope}.${operation}`,
    path: operation === 'create' ? createReviewPath : updateReviewPath,
    questId,
    reviewId,
    body,
  });
};

const assignmentExists = async (
  transaction: QuestTransaction,
  questId: string,
  workerId: string
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
  requestedRevieweeId: string | undefined
): Promise<{ revieweeId: string } | { outcome: 'not-authorized' | 'reviewee-required' }> => {
  if (reviewerId === current.hirerId) {
    if (!requestedRevieweeId) return { outcome: 'reviewee-required' };
    if (
      requestedRevieweeId === current.hirerId ||
      !(await assignmentExists(transaction, questId, requestedRevieweeId))
    )
      return { outcome: 'not-authorized' };
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

const existingReview = async (transaction: QuestTransaction, questId: string, reviewId: string) =>
  (
    await transaction
      .select(reviewFields)
      .from(review)
      .where(and(eq(review.id, reviewId), eq(review.questId, questId)))
      .limit(1)
      .for('update')
  )[0];

const isValidReviewPair = async (
  transaction: QuestTransaction,
  current: QuestRow,
  questId: string,
  reviewerId: string,
  revieweeId: string
): Promise<boolean> => {
  if (reviewerId === current.hirerId) {
    return (
      revieweeId !== current.hirerId && (await assignmentExists(transaction, questId, revieweeId))
    );
  }
  return (
    revieweeId === current.hirerId && (await assignmentExists(transaction, questId, reviewerId))
  );
};

const isReviewable = (current: QuestRow): boolean => isTerminalQuestStatus(current.questStatus);

export const createQuestV2Review = async (
  reviewerId: string,
  questId: string,
  input: ReviewCreateInput,
  rawCommandId: string,
  now = new Date()
): Promise<QuestV2ReviewOutcome> => {
  const requestHash = await reviewRequestHash(reviewerId, 'create', questId, null, input);

  return db.transaction(async (transaction) => {
    const current = await lockQuest(transaction, questId);
    if (!current) return { outcome: 'not-found' };

    const command = await runQuestCommand({
      transaction,
      identity: {
        principalUserId: reviewerId,
        operationScope: `${reviewOperationScope}.create`,
        key: rawCommandId,
        requestHash,
        questId,
      },
      now,
      work: async (): Promise<QuestCommandWork<QuestV2ReviewRow, ReviewBusinessOutcomeCode>> => {
        if (!isReviewable(current)) return { kind: 'rejected', rejection: 'not-terminal' };
        if (!isValidRating(input.rating)) return { kind: 'rejected', rejection: 'invalid-rating' };
        const comment = normalizeComment(input.comment);
        if ('outcome' in comment) return { kind: 'rejected', rejection: comment.outcome };

        const reviewee = await revieweeForCreate(
          transaction,
          current,
          questId,
          reviewerId,
          input.revieweeId
        );
        if ('outcome' in reviewee) return { kind: 'rejected', rejection: reviewee.outcome };

        const existing = await transaction
          .select({ id: review.id })
          .from(review)
          .where(
            and(
              eq(review.questId, questId),
              eq(review.reviewerId, reviewerId),
              eq(review.revieweeId, reviewee.revieweeId)
            )
          )
          .limit(1)
          .for('update');
        if (existing[0]) return { kind: 'rejected', rejection: 'already-exists' };
        if (now.getTime() > reviewDeadline(current.updatedAt).getTime()) {
          return { kind: 'rejected', rejection: 'window-expired' };
        }

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
        if (!created) return { kind: 'rejected', rejection: 'conflict' };

        return {
          kind: 'success',
          result: created,
          resourceType: 'quest-v2-review',
          resourceId: created.id,
        };
      },
      toSnapshot: reviewSnapshot,
      fromSnapshot: reviewFromSnapshot,
    });
    if ('outcome' in command) return { outcome: command.outcome };
    if (command.kind === 'success') return command.result;
    return { outcome: command.rejection };
  });
};

export const updateQuestV2Review = async (
  reviewerId: string,
  questId: string,
  reviewId: string,
  input: ReviewUpdateInput,
  rawCommandId: string,
  now = new Date()
): Promise<QuestV2ReviewOutcome> => {
  const requestHash = await reviewRequestHash(reviewerId, 'update', questId, reviewId, input);

  return db.transaction(async (transaction) => {
    const current = await lockQuest(transaction, questId);
    if (!current) return { outcome: 'not-found' };

    const command = await runQuestCommand({
      transaction,
      identity: {
        principalUserId: reviewerId,
        operationScope: `${reviewOperationScope}.update`,
        key: rawCommandId,
        requestHash,
        questId,
      },
      now,
      work: async (): Promise<QuestCommandWork<QuestV2ReviewRow, ReviewBusinessOutcomeCode>> => {
        if (!isReviewable(current)) return { kind: 'rejected', rejection: 'not-terminal' };
        const currentReview = await existingReview(transaction, questId, reviewId);
        if (!currentReview) return { kind: 'rejected', rejection: 'review-not-found' };
        if (currentReview.reviewerId !== reviewerId) {
          return { kind: 'rejected', rejection: 'not-authorized' };
        }
        if (
          !(await isValidReviewPair(
            transaction,
            current,
            questId,
            currentReview.reviewerId,
            currentReview.revieweeId
          ))
        )
          return { kind: 'rejected', rejection: 'not-authorized' };
        if (now.getTime() > reviewDeadline(current.updatedAt).getTime()) {
          return { kind: 'rejected', rejection: 'window-expired' };
        }

        const values: {
          rating?: number;
          comment?: string;
          updatedAt: Date;
        } = { updatedAt: now };
        if (input.rating !== undefined) {
          if (!isValidRating(input.rating))
            return { kind: 'rejected', rejection: 'invalid-rating' };
          values.rating = input.rating;
        }
        if (input.comment !== undefined) {
          const comment = normalizeComment(input.comment);
          if ('outcome' in comment || comment.value === null) {
            return { kind: 'rejected', rejection: 'invalid-comment' };
          }
          values.comment = comment.value;
        }
        if (values.rating === undefined && values.comment === undefined) {
          return { kind: 'rejected', rejection: 'conflict' };
        }

        const [updated] = await transaction
          .update(review)
          .set(values)
          .where(eq(review.id, reviewId))
          .returning(reviewFields);
        if (!updated) return { kind: 'rejected', rejection: 'conflict' };

        return {
          kind: 'success',
          result: updated,
          resourceType: 'quest-v2-review',
          resourceId: updated.id,
        };
      },
      toSnapshot: reviewSnapshot,
      fromSnapshot: reviewFromSnapshot,
    });
    if ('outcome' in command) return { outcome: command.outcome };
    if (command.kind === 'success') return command.result;
    return { outcome: command.rejection };
  });
};
