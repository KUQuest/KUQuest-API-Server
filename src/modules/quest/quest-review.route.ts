import { authGuard } from '@/modules/auth';
import { apiSuccessSchema, betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { API_V1_PREFIX } from '@/shared/api-version';
import { rejectUnknownFields } from '@/shared/reject-unknown-fields';

import { Elysia } from 'elysia';

import {
  createReviewController,
  deleteReviewController,
  updateReviewController,
} from './quest-review.controller';
import {
  questReviewCreateSchema,
  questReviewDetailParamsSchema,
  questReviewParamsSchema,
  questReviewResponseSchema,
  questReviewUpdateSchema,
} from './quest-review.schema';

export const questReviewRoute = new Elysia({
  name: 'quest-review-route',
  prefix: `${API_V1_PREFIX}/quests`,
})
  .use(authGuard)
  .post('/:questId/reviews', createReviewController, {
    params: questReviewParamsSchema,
    body: questReviewCreateSchema,
    transform: rejectUnknownFields(questReviewCreateSchema),
    response: responses(questReviewResponseSchema, 400, 401, 403, 404, 409),
    detail: {
      tags: ['Reviews'],
      summary: 'Create a Review after Quest completion',
      description: 'Allows the Hirer to review each completed Worker and each completed Worker to review the Hirer, once per direction within seven days of completion. A second create for the same direction returns REVIEW_ALREADY_EXISTS; use the edit operation to change an authored Review.',
      operationId: 'createQuestReview',
      security: betterAuthSecurity,
    },
  })
  .patch('/:questId/reviews/:reviewId', updateReviewController, {
    params: questReviewDetailParamsSchema,
    body: questReviewUpdateSchema,
    transform: rejectUnknownFields(questReviewUpdateSchema),
    response: responses(questReviewResponseSchema, 400, 401, 403, 404, 409),
    detail: {
      tags: ['Reviews'],
      summary: 'Edit an authored Review',
      description: 'Edits a Review without changing its author, direction, or Quest. The seven-day deadline is measured from Quest completion and does not move when edited.',
      operationId: 'updateQuestReview',
      security: betterAuthSecurity,
    },
  })
  .delete('/:questId/reviews/:reviewId', deleteReviewController, {
    params: questReviewDetailParamsSchema,
    response: responses(apiSuccessSchema, 401, 409),
    detail: {
      tags: ['Reviews'],
      summary: 'Delete a Review',
      description: 'Reviews are immutable resources and cannot be deleted.',
      operationId: 'deleteQuestReview',
      security: betterAuthSecurity,
    },
  });
