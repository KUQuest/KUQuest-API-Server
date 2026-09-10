import { authGuard } from '@/modules/auth';
import { API_V1_PREFIX } from '@/shared/api-version';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';

import { Elysia } from 'elysia';

import {
  createTopUpController,
  createTopUpQuoteController,
  getTopUpController,
  listTopUpStatusHistoryController,
  listTopUpsController,
} from './top-up.controller';
import {
  topUpCreateSchema,
  topUpIdempotencyHeadersSchema,
  topUpListQuerySchema,
  topUpParamsSchema,
  topUpQuoteCreateSchema,
  topUpQuoteResponseSchema,
  topUpListResponseSchema,
  topUpResponseSchema,
  topUpStatusHistoryResponseSchema,
} from './top-up.schema';

export const topUpRoute = new Elysia({
  name: 'top-up-route',
  prefix: `${API_V1_PREFIX}/top-ups`,
})
  .use(authGuard)
  .post('/quotes', createTopUpQuoteController, {
    body: topUpQuoteCreateSchema,
    response: responses(topUpQuoteResponseSchema, 400, 401, 409),
    detail: {
      tags: ['Top-ups'],
      summary: 'Quote a Top-up',
      operationId: 'quoteTopUp',
      security: betterAuthSecurity,
    },
  })
  .post('', createTopUpController, {
    body: topUpCreateSchema,
    headers: topUpIdempotencyHeadersSchema,
    response: responses(topUpResponseSchema, 400, 401, 404, 409, 502),
    detail: {
      tags: ['Top-ups'],
      summary: 'Create a PromptPay Top-up Payment Request',
      description: 'Confirms a binding Provider Quote and returns the Xendit PromptPay QR. Set simulate=true only in a staging or development test runtime with an Xendit Development key.',
      operationId: 'createTopUp',
      security: betterAuthSecurity,
    },
  })
  .get('', listTopUpsController, {
    query: topUpListQuerySchema,
    response: responses(topUpListResponseSchema, 400, 401),
    detail: {
      tags: ['Top-ups'],
      summary: 'List own Top-ups',
      operationId: 'listTopUps',
      security: betterAuthSecurity,
    },
  })
  .get('/:topUpId/status-history', listTopUpStatusHistoryController, {
    params: topUpParamsSchema,
    response: responses(topUpStatusHistoryResponseSchema, 401, 404),
    detail: {
      tags: ['Top-ups'],
      summary: 'List Top-up status history',
      operationId: 'listTopUpStatusHistory',
      security: betterAuthSecurity,
    },
  })
  .get('/:topUpId', getTopUpController, {
    params: topUpParamsSchema,
    response: responses(topUpResponseSchema, 401, 404),
    detail: {
      tags: ['Top-ups'],
      summary: 'Get a Top-up',
      operationId: 'getTopUp',
      security: betterAuthSecurity,
    },
  });
