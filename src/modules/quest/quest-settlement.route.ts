import { authGuard } from '@/modules/auth';
import { API_V1_PREFIX } from '@/shared/api-version';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';

import { Elysia } from 'elysia';

import { cancelQuestController } from './quest-settlement.controller';
import {
  questCancellationResponseSchema,
  questSettlementHeadersSchema,
  questSettlementParamsSchema,
} from './quest-settlement.schema';
import { createQuestIdempotencyKeyGuard } from './quest-idempotency.guard';

export const questSettlementRoute = new Elysia({ name: 'quest-settlement-route', prefix: `${API_V1_PREFIX}/quests` })
  .use(createQuestIdempotencyKeyGuard('quest-cancellation'))
  .use(authGuard)
  .post('/:questId/cancel', cancelQuestController, {
    params: questSettlementParamsSchema,
    headers: questSettlementHeadersSchema,
    response: responses(questCancellationResponseSchema, 400, 401, 403, 404, 409, 503),
    detail: {
      tags: ['Quest Settlement'],
      summary: 'Cancel a Quest as its Hirer',
      description: 'Cancels a Draft without settlement, or an OPEN, ASSIGNED, or IN_PROGRESS Quest with the stage-specific Funding Reservation settlement.',
      operationId: 'cancelQuest',
      security: betterAuthSecurity,
    },
  });
