import { authGuard } from '@/modules/auth';
import { API_V1_PREFIX } from '@/shared/api-version';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';

import { Elysia } from 'elysia';

import {
  createPayoutController,
  createPayoutQuoteController,
  getPayoutController,
  listPayoutsController,
  listPayoutStatusHistoryController,
} from './payout.controller';
import {
  payoutCreateSchema,
  payoutIdempotencyHeadersSchema,
  payoutListQuerySchema,
  payoutParamsSchema,
  payoutQuoteCreateSchema,
  payoutQuoteResponseSchema,
  payoutListResponseSchema,
  payoutResponseSchema,
  payoutStatusHistoryResponseSchema,
} from './payout.schema';

export const payoutRoute = new Elysia({
  name: 'payout-route',
  prefix: `${API_V1_PREFIX}/payouts`,
})
  .use(authGuard)
  .post('/quotes', createPayoutQuoteController, {
    body: payoutQuoteCreateSchema,
    response: responses(payoutQuoteResponseSchema, 400, 401, 404, 409),
    detail: {
      tags: ['Payouts'],
      summary: 'Quote a Payout',
      operationId: 'quotePayout',
      security: betterAuthSecurity,
    },
  })
  .post('', createPayoutController, {
    body: payoutCreateSchema,
    headers: payoutIdempotencyHeadersSchema,
    response: responses(payoutResponseSchema, 400, 401, 404, 409),
    detail: {
      tags: ['Payouts'],
      summary: 'Submit a Payout for Admin approval',
      description: 'Reserves the full Payout amount and waits for an Admin decision. The Provider is not called by this request.',
      operationId: 'createPayout',
      security: betterAuthSecurity,
    },
  })
  .get('', listPayoutsController, {
    query: payoutListQuerySchema,
    response: responses(payoutListResponseSchema, 400, 401),
    detail: {
      tags: ['Payouts'],
      summary: 'List own Payouts',
      operationId: 'listPayouts',
      security: betterAuthSecurity,
    },
  })
  .get('/:payoutId/status-history', listPayoutStatusHistoryController, {
    params: payoutParamsSchema,
    response: responses(payoutStatusHistoryResponseSchema, 401, 404),
    detail: {
      tags: ['Payouts'],
      summary: 'List Payout status history',
      operationId: 'listPayoutStatusHistory',
      security: betterAuthSecurity,
    },
  })
  .get('/:payoutId', getPayoutController, {
    params: payoutParamsSchema,
    response: responses(payoutResponseSchema, 401, 404),
    detail: {
      tags: ['Payouts'],
      summary: 'Get a Payout',
      operationId: 'getPayout',
      security: betterAuthSecurity,
    },
  });
