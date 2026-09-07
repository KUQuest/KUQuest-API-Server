import { enabledAdminGuard } from '@/modules/auth';
import { API_V1_PREFIX } from '@/shared/api-version';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';

import { Elysia } from 'elysia';

import {
  approvePayoutController,
  getAdminPayoutController,
  listAdminPayoutStatusHistoryController,
  listAdminPayoutsController,
  rejectPayoutController,
} from './payout.admin.controller';
import {
  adminPayoutApprovalSchema,
  adminPayoutDetailResponseSchema,
  adminPayoutHeadersSchema,
  adminPayoutHistoryResponseSchema,
  adminPayoutListQuerySchema,
  adminPayoutListResponseSchema,
  adminPayoutParamsSchema,
  adminPayoutRejectionSchema,
  adminPayoutResponseSchema,
} from './payout.admin.schema';

export const adminPayoutRoute = new Elysia({
  name: 'admin-payout-route',
  prefix: `${API_V1_PREFIX}/admin/payouts`,
})
  .use(enabledAdminGuard)
  .get('', listAdminPayoutsController, {
    query: adminPayoutListQuerySchema,
    response: responses(adminPayoutListResponseSchema, 400, 401, 403),
    detail: {
      tags: ['Admin Payouts'],
      summary: 'List Payouts for Admin review',
      description: 'Lists waiting Payouts by default. Historical status filters, cursor pagination, and newest or oldest sorting are supported.',
      operationId: 'listAdminPayouts',
      security: betterAuthSecurity,
    },
  })
  .get('/:payoutId/status-history', listAdminPayoutStatusHistoryController, {
    params: adminPayoutParamsSchema,
    response: responses(adminPayoutHistoryResponseSchema, 401, 403, 404),
    detail: {
      tags: ['Admin Payouts'],
      summary: 'List Payout status history for Admin review',
      operationId: 'listAdminPayoutStatusHistory',
      security: betterAuthSecurity,
    },
  })
  .get('/:payoutId', getAdminPayoutController, {
    params: adminPayoutParamsSchema,
    response: responses(adminPayoutDetailResponseSchema, 401, 403, 404),
    detail: {
      tags: ['Admin Payouts'],
      summary: 'Get Payout detail for Admin review',
      operationId: 'getAdminPayout',
      security: betterAuthSecurity,
    },
  })
  .post('/:payoutId/approve', approvePayoutController, {
    params: adminPayoutParamsSchema,
    headers: adminPayoutHeadersSchema,
    body: adminPayoutApprovalSchema,
    response: responses(adminPayoutResponseSchema, 400, 401, 403, 404, 409, 503),
    detail: {
      tags: ['Admin Payouts'],
      summary: 'Approve a waiting Payout',
      description: 'Records a final Admin approval and hands the Payout to the separate Payout Worker. The Provider is called by the Worker, not this request.',
      operationId: 'approvePayout',
      security: betterAuthSecurity,
    },
  })
  .post('/:payoutId/reject', rejectPayoutController, {
    params: adminPayoutParamsSchema,
    headers: adminPayoutHeadersSchema,
    body: adminPayoutRejectionSchema,
    response: responses(adminPayoutResponseSchema, 400, 401, 403, 404, 409, 503),
    detail: {
      tags: ['Admin Payouts'],
      summary: 'Reject a waiting Payout',
      description: 'Records a final Admin rejection with a reason and releases the full Payout Reserve to Earnings Balance.',
      operationId: 'rejectPayout',
      security: betterAuthSecurity,
    },
  });
