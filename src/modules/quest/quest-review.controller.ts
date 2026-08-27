import type { AuthedContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';

import type { Static } from 'elysia';

import type {
  questReviewCreateSchema,
  questReviewDetailParamsSchema,
  questReviewParamsSchema,
  questReviewUpdateSchema,
} from './quest-review.schema';
import { createReview, updateReview } from './quest-review.service';

type CreateInput = Static<typeof questReviewCreateSchema>;
type UpdateInput = Static<typeof questReviewUpdateSchema>;
type Params = Static<typeof questReviewParamsSchema>;
type DetailParams = Static<typeof questReviewDetailParamsSchema>;

type ReviewResult = Awaited<ReturnType<typeof createReview>>;

const mapOutcome = (set: AuthedContext['set'], result: Exclude<ReviewResult, { id: string }>) => {
  if (result.outcome === 'not-found') {
    set.status = 404;
    return apiError('QUEST_NOT_FOUND', 'Quest or Review not found');
  }
  if (result.outcome === 'already-exists') {
    set.status = 409;
    return apiError('REVIEW_ALREADY_EXISTS', 'A Review already exists for this Quest and direction');
  }
  if (result.outcome === 'expired') {
    set.status = 409;
    return apiError('REVIEW_WINDOW_EXPIRED', 'Reviews can only be created or edited within seven days of Quest completion');
  }
  if (result.outcome === 'delete-not-allowed') {
    set.status = 409;
    return apiError('REVIEW_DELETE_NOT_ALLOWED', 'Reviews cannot be deleted');
  }
  if (result.outcome === 'conflict') {
    set.status = 409;
    return apiError('REVIEW_CONFLICT', 'The Review could not be saved');
  }
  set.status = 403;
  return apiError('REVIEW_NOT_ALLOWED', 'You are not an eligible participant for this Review');
};

export const createReviewController = async ({
  body,
  params,
  session,
  set,
}: AuthedContext & { body: CreateInput; params: Params }): Promise<ApiResponse> => {
  const result = await createReview(session.user.id, params.questId, body);
  if ('outcome' in result) return mapOutcome(set, result);
  return apiSuccess({
    ...result,
    createdAt: result.createdAt.toISOString(),
    updatedAt: result.updatedAt.toISOString(),
  });
};

export const updateReviewController = async ({
  body,
  params,
  session,
  set,
}: AuthedContext & { body: UpdateInput; params: DetailParams }): Promise<ApiResponse> => {
  const result = await updateReview(session.user.id, params.questId, params.reviewId, body);
  if ('outcome' in result) return mapOutcome(set, result);
  return apiSuccess({
    ...result,
    createdAt: result.createdAt.toISOString(),
    updatedAt: result.updatedAt.toISOString(),
  });
};

export const deleteReviewController = ({ set }: AuthedContext): ApiResponse => {
  set.status = 409;
  return apiError('REVIEW_DELETE_NOT_ALLOWED', 'Reviews cannot be deleted');
};
