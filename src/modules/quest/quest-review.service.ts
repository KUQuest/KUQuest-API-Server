import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';
import { quest, questAssignment, review } from '@/database/schema/quest.schema';

import { and, count, desc, eq, exists, inArray, lt, or, sql } from 'drizzle-orm';

import { assignmentStatus, questStatus, terminalQuestStatuses } from './quest.contract';
import type { QuestTransaction } from './quest-assignment.service';

type ReviewInput = { revieweeId?: string; rating: number; comment?: string };
type ReviewUpdate = { rating?: number; comment?: string };

export type ReviewRow = {
  id: string;
  questId: string;
  reviewerId: string;
  revieweeId: string;
  rating: number;
  comment: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ReviewOutcome =
  | ReviewRow
  | { outcome: 'not-found' | 'not-eligible' | 'expired' | 'delete-not-allowed' | 'conflict' | 'already-exists' };

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

const completionDeadline = (completedAt: Date): Date =>
  new Date(completedAt.getTime() + 7 * 24 * 60 * 60 * 1000);

const validReviewee = async (
  tx: QuestTransaction,
  questId: string,
  hirerId: string,
  reviewerId: string,
  revieweeId: string,
): Promise<boolean> => {
  if (reviewerId === hirerId) {
    if (revieweeId === hirerId) return false;
    const [assignment] = await tx
      .select({ id: questAssignment.id })
      .from(questAssignment)
      .where(
        and(
          eq(questAssignment.questId, questId),
          eq(questAssignment.workerId, revieweeId),
          eq(questAssignment.assignmentStatus, assignmentStatus.completed),
        ),
      )
      .limit(1);
    return Boolean(assignment);
  }

  if (revieweeId !== hirerId) return false;
  const [assignment] = await tx
    .select({ id: questAssignment.id })
    .from(questAssignment)
    .where(
      and(
        eq(questAssignment.questId, questId),
        eq(questAssignment.workerId, reviewerId),
        eq(questAssignment.assignmentStatus, assignmentStatus.completed),
      ),
    )
    .limit(1);
  return Boolean(assignment);
};

const selectReview = async (tx: QuestTransaction, reviewId: string, questId?: string) => {
  const conditions = [eq(review.id, reviewId)];
  if (questId) conditions.push(eq(review.questId, questId));
  return (await tx.select(reviewFields).from(review).where(and(...conditions)).limit(1))[0];
};

/** Create a directional Review in the same transaction as its eligibility check. */
export const createReview = async (
  reviewerId: string,
  questId: string,
  input: ReviewInput,
  now = new Date(),
): Promise<ReviewOutcome> =>
  db.transaction(async (tx) => {
    const current = (
      await tx
        .select({ id: quest.id, hirerId: quest.hirerId, questStatus: quest.questStatus, updatedAt: quest.updatedAt })
        .from(quest)
        .where(eq(quest.id, questId))
        .limit(1)
        .for('update')
    )[0];
    if (!current) return { outcome: 'not-found' };
    if (current.questStatus !== questStatus.completed) return { outcome: 'not-eligible' };

    const revieweeId = input.revieweeId ?? current.hirerId;
    const existing = await tx
      .select(reviewFields)
      .from(review)
      .where(
        and(
          eq(review.questId, questId),
          eq(review.reviewerId, reviewerId),
          eq(review.revieweeId, revieweeId),
        ),
      )
      .limit(1)
      .for('update');
    if (existing[0]) return { outcome: 'already-exists' };

    if (now > completionDeadline(current.updatedAt)) return { outcome: 'expired' };
    if (!(await validReviewee(tx, questId, current.hirerId, reviewerId, revieweeId))) {
      return { outcome: 'not-eligible' };
    }

    const [created] = await tx
      .insert(review)
      .values({
        questId,
        reviewerId,
        revieweeId,
        rating: input.rating,
        comment: input.comment?.trim() ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [review.questId, review.reviewerId, review.revieweeId],
      })
      .returning(reviewFields);
    if (created) return created;

    const concurrent = await tx
      .select(reviewFields)
      .from(review)
      .where(
        and(
          eq(review.questId, questId),
          eq(review.reviewerId, reviewerId),
          eq(review.revieweeId, revieweeId),
        ),
      )
      .limit(1)
      .for('update');
    return concurrent[0] ? { outcome: 'already-exists' } : { outcome: 'conflict' };
  });

export const updateReview = async (
  reviewerId: string,
  questId: string,
  reviewId: string,
  input: ReviewUpdate,
  now = new Date(),
): Promise<ReviewOutcome> =>
  db.transaction(async (tx) => {
    const current = (
      await tx
        .select({ questStatus: quest.questStatus, updatedAt: quest.updatedAt })
        .from(quest)
        .where(eq(quest.id, questId))
        .limit(1)
        .for('update')
    )[0];
    if (!current || current.questStatus !== questStatus.completed) return { outcome: 'not-eligible' };

    const existing = await selectReview(tx, reviewId, questId);
    if (!existing) return { outcome: 'not-found' };
    if (existing.reviewerId !== reviewerId) return { outcome: 'not-eligible' };
    if (now > completionDeadline(current.updatedAt)) return { outcome: 'expired' };

    const [updated] = await tx
      .update(review)
      .set({
        ...(input.rating === undefined ? {} : { rating: input.rating }),
        ...(input.comment === undefined ? {} : { comment: input.comment.trim() }),
        updatedAt: now,
      })
      .where(eq(review.id, reviewId))
      .returning(reviewFields);
    return updated ?? { outcome: 'conflict' };
  });

const validReviewPredicate = (memberId: string) =>
  or(
    and(
      eq(review.revieweeId, memberId),
      eq(review.reviewerId, quest.hirerId),
      exists(
        db
          .select({ id: questAssignment.id })
          .from(questAssignment)
          .where(
            and(
              eq(questAssignment.questId, review.questId),
              eq(questAssignment.workerId, review.revieweeId),
            ),
          ),
      ),
    ),
    and(
      eq(review.revieweeId, memberId),
      eq(review.revieweeId, quest.hirerId),
      exists(
        db
          .select({ id: questAssignment.id })
          .from(questAssignment)
          .where(
            and(
              eq(questAssignment.questId, review.questId),
              eq(questAssignment.workerId, review.reviewerId),
            ),
          ),
      ),
    ),
  );

/** Return only Reviews backed by a terminal Quest and Assignment relationship. */
export const listReviews = async (
  memberId: string,
  options: { rating?: number; limit?: number; cursor?: { startTime: string; id: string } } = {},
) => {
  const conditions = [inArray(quest.questStatus, terminalQuestStatuses), validReviewPredicate(memberId)];
  if (options.rating !== undefined) conditions.push(eq(review.rating, options.rating));
  if (options.cursor) {
    conditions.push(
      or(
        lt(review.createdAt, new Date(options.cursor.startTime)),
        and(eq(review.createdAt, new Date(options.cursor.startTime)), lt(review.id, options.cursor.id)),
      )!,
    );
  }
  const limit = options.limit ?? 20;
  const rows = await db
    .select({
      id: review.id,
      questId: review.questId,
      rating: review.rating,
      comment: review.comment,
      createdAt: review.createdAt,
      updatedAt: review.updatedAt,
      questTitle: quest.title,
      reviewerFirstName: authUser.firstName,
      reviewerLastName: authUser.lastName,
      avatarBucket: file.bucket,
      avatarObjectKey: file.objectKey,
    })
    .from(review)
    .innerJoin(quest, eq(review.questId, quest.id))
    .innerJoin(authUser, eq(review.reviewerId, authUser.id))
    .leftJoin(file, and(eq(authUser.imageFileId, file.id), sql`${file.deletedAt} IS NULL`))
    .where(and(...conditions))
    .orderBy(desc(review.createdAt), desc(review.id))
    .limit(limit + 1);
  const hasNext = rows.length > limit;
  return { rows: rows.slice(0, limit), hasNext };
};

export const countReviews = async (memberId: string, rating?: number) => {
  const conditions = [inArray(quest.questStatus, terminalQuestStatuses), validReviewPredicate(memberId)];
  if (rating !== undefined) conditions.push(eq(review.rating, rating));
  const [row] = await db
    .select({ total: count(review.id) })
    .from(review)
    .innerJoin(quest, eq(review.questId, quest.id))
    .where(and(...conditions));
  return Number(row?.total ?? 0);
};

export const getReceivedRatings = async (memberId: string): Promise<number[]> => {
  const rows = await db
    .select({ rating: review.rating })
    .from(review)
    .innerJoin(quest, eq(review.questId, quest.id))
    .where(and(inArray(quest.questStatus, terminalQuestStatuses), validReviewPredicate(memberId)));
  return rows.map(({ rating }) => rating);
};

export const deleteReview = async (): Promise<ReviewOutcome> => ({ outcome: 'delete-not-allowed' });
