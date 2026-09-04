import type { AuthedContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';

import type {
  QuestV2ReviewCreateInput,
  QuestV2ReviewDetailParams,
  QuestV2ReviewParams,
  QuestV2ReviewUpdateInput,
} from './quest-review-v2.schema';
import {
  createQuestV2Review,
  updateQuestV2Review,
  type QuestV2ReviewOutcome,
  type QuestV2ReviewRow,
} from './quest-review-v2.service';

const serializeReview = (review: QuestV2ReviewRow) => ({
  id: review.id,
  questId: review.questId,
  reviewerId: review.reviewerId,
  revieweeId: review.revieweeId,
  rating: review.rating,
  comment: review.comment,
  createdAt: review.createdAt.toISOString(),
  updatedAt: review.updatedAt.toISOString(),
});

const requiredCommandId = (request: Request | undefined, set: AuthedContext['set']) => {
  const commandId = request?.headers.get('idempotency-key');
  if (commandId?.trim()) return commandId;
  set.status = 400;
  return apiError('IDEMPOTENCY_KEY_REQUIRED', 'The Idempotency-Key header is required');
};

const conflict = (set: AuthedContext['set'], code: string, message: string) => {
  set.status = 409;
  return apiError(code, message);
};

const mapReviewError = (
  set: AuthedContext['set'],
  result: Exclude<QuestV2ReviewOutcome, QuestV2ReviewRow>,
) => {
  if (result.outcome === 'not-found') {
    set.status = 404;
    return apiError('QUEST_NOT_FOUND', 'Quest not found');
  }
  if (result.outcome === 'review-not-found') {
    set.status = 404;
    return apiError('REVIEW_NOT_FOUND', 'Review not found');
  }
  if (result.outcome === 'not-authorized') {
    set.status = 403;
    return apiError('REVIEW_NOT_ALLOWED', 'You are not an eligible participant for this Review');
  }
  if (result.outcome === 'reviewee-required') {
    set.status = 400;
    return apiError('REVIEWEE_REQUIRED', 'The Hirer must select a Worker to review');
  }
  if (result.outcome === 'not-terminal') {
    return conflict(set, 'QUEST_NOT_TERMINAL', 'Reviews are available only after a Quest reaches a Terminal State');
  }
  if (result.outcome === 'already-exists') {
    return conflict(set, 'REVIEW_ALREADY_EXISTS', 'A Review already exists for this Quest and direction');
  }
  if (result.outcome === 'window-expired') {
    return conflict(set, 'REVIEW_WINDOW_EXPIRED', 'Reviews can only be created or edited within seven days of the Quest becoming Terminal');
  }
  if (result.outcome === 'idempotency-key-reused') {
    return conflict(set, 'IDEMPOTENCY_KEY_REUSED', 'The Idempotency-Key was used for a different request');
  }
  if (result.outcome === 'idempotency-in-progress') {
    return conflict(set, 'IDEMPOTENCY_IN_PROGRESS', 'The Idempotency-Key is still processing');
  }
  if (result.outcome === 'idempotency-unavailable') {
    set.status = 503;
    return apiError('IDEMPOTENCY_UNAVAILABLE', 'The Idempotency-Key result is unavailable');
  }
  if (result.outcome === 'invalid-rating') {
    set.status = 400;
    return apiError('INVALID_RATING', 'rating must be an integer from 1 through 5');
  }
  if (result.outcome === 'invalid-comment') {
    set.status = 400;
    return apiError('INVALID_COMMENT', 'comment must be non-blank and at most 1,000 characters');
  }
  if (result.outcome === 'invalid-idempotency-key') {
    set.status = 400;
    return apiError('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must not be empty');
  }
  set.status = 409;
  return apiError('REVIEW_CONFLICT', 'The Review could not be saved');
};

export const createQuestV2ReviewController = async ({
  body,
  params,
  request,
  session,
  set,
}: AuthedContext & {
  body: QuestV2ReviewCreateInput;
  params: QuestV2ReviewParams;
}) => {
  const commandId = requiredCommandId(request, set);
  if (typeof commandId !== 'string') return commandId;

  const result = await createQuestV2Review(session.user.id, params.questId, body, commandId);
  if ('outcome' in result) return mapReviewError(set, result);
  return apiSuccess(serializeReview(result));
};

export const updateQuestV2ReviewController = async ({
  body,
  params,
  request,
  session,
  set,
}: AuthedContext & {
  body: QuestV2ReviewUpdateInput;
  params: QuestV2ReviewDetailParams;
}) => {
  const commandId = requiredCommandId(request, set);
  if (typeof commandId !== 'string') return commandId;

  const result = await updateQuestV2Review(
    session.user.id,
    params.questId,
    params.reviewId,
    body,
    commandId,
  );
  if ('outcome' in result) return mapReviewError(set, result);
  return apiSuccess(serializeReview(result));
};
