import { authGuard } from '@/modules/auth';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { API_V2_PREFIX } from '@/shared/api-version';
import { rejectUnknownFields } from '@/shared/reject-unknown-fields';

import { Elysia } from 'elysia';

import {
  createQuestV2ReviewController,
  updateQuestV2ReviewController,
} from './quest-review-v2.controller';
import { createQuestIdempotencyKeyGuard } from './quest-idempotency.guard';
import {
  questV2ReviewCreateSchema,
  questV2ReviewDetailParamsSchema,
  questV2ReviewHeadersSchema,
  questV2ReviewParamsSchema,
  questV2ReviewResponseSchema,
  questV2ReviewUpdateSchema,
} from './quest-review-v2.schema';

export const questReviewV2Route = new Elysia({
  name: 'quest-review-v2-route',
  prefix: `${API_V2_PREFIX}/quests`,
})
  .use(createQuestIdempotencyKeyGuard('rating-review-v2'))
  .use(authGuard)
  .post('/:questId/reviews', createQuestV2ReviewController, {
    params: questV2ReviewParamsSchema,
    body: questV2ReviewCreateSchema,
    headers: questV2ReviewHeadersSchema,
    transform: rejectUnknownFields(questV2ReviewCreateSchema),
    response: responses(questV2ReviewResponseSchema, 400, 401, 403, 404, 409, 500, 503),
    detail: {
      tags: ['Quest Reviews v2'],
      summary: 'Create a v2 Rating Review',
      description:
        'Creates one Rating Review after the Quest reaches QUEST_COMPLETED, QUEST_FAILED, or QUEST_CANCELLED. The command does not change Quest, Assignment, Work Chat, or money state. A matching Idempotency-Key replays the original result.',
      operationId: 'createQuestReviewV2',
      security: betterAuthSecurity,
    },
  })
  .patch('/:questId/reviews/:reviewId', updateQuestV2ReviewController, {
    params: questV2ReviewDetailParamsSchema,
    body: questV2ReviewUpdateSchema,
    headers: questV2ReviewHeadersSchema,
    transform: rejectUnknownFields(questV2ReviewUpdateSchema),
    response: responses(questV2ReviewResponseSchema, 400, 401, 403, 404, 409, 500, 503),
    detail: {
      tags: ['Quest Reviews v2'],
      summary: 'Edit a v2 Rating Review',
      description:
        'Edits the author’s Rating Review within seven days after the Quest becomes Terminal. The terminal Quest values are QUEST_COMPLETED, QUEST_FAILED, and QUEST_CANCELLED. The command does not change Quest, Assignment, Work Chat, or money state.',
      operationId: 'updateQuestReviewV2',
      security: betterAuthSecurity,
    },
  });
