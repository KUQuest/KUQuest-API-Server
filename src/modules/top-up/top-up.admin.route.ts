import { enabledAdminGuard } from '@/modules/auth';
import { API_V1_PREFIX } from '@/shared/api-version';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';

import { Elysia } from 'elysia';

import {
  listAdminTopUpsController,
  reconcileTopUpAdminController,
  retryTopUpEventAdminController,
} from './top-up.admin.controller';
import {
  adminTopUpEventParamsSchema,
  adminTopUpEventResponseSchema,
  adminTopUpListQuerySchema,
  adminTopUpListResponseSchema,
  adminTopUpParamsSchema,
  adminTopUpResponseSchema,
} from './top-up.admin.schema';

export const adminTopUpRoute = new Elysia({
  name: 'admin-top-up-route',
  prefix: `${API_V1_PREFIX}/admin/top-ups`,
})
  .use(enabledAdminGuard)
  .get('', listAdminTopUpsController, {
    query: adminTopUpListQuerySchema,
    response: responses(adminTopUpListResponseSchema, 400, 401, 403),
    detail: {
      tags: ['Admin Top-Ups'],
      summary: 'List and filter Top-Ups for Admin review',
      description: 'Returns paginated PromptPay Top-Ups with status, amount, and member details.',
      operationId: 'listAdminTopUps',
      security: betterAuthSecurity,
    },
  })
  .post('/:topUpId/reconcile', reconcileTopUpAdminController, {
    params: adminTopUpParamsSchema,
    response: responses(adminTopUpResponseSchema, 400, 401, 403, 404, 409, 500, 502),
    detail: {
      tags: ['Admin Top-Ups'],
      summary: 'Reconcile a Top-Up with the Payment Provider',
      description: 'Reconciles the Top-Up state against the inbound payment provider status.',
      operationId: 'reconcileTopUp',
      security: betterAuthSecurity,
    },
  })
  .post('/events/:eventId/retry', retryTopUpEventAdminController, {
    params: adminTopUpEventParamsSchema,
    response: responses(adminTopUpEventResponseSchema, 400, 401, 403, 404, 409, 500),
    detail: {
      tags: ['Admin Top-Ups'],
      summary: 'Retry a failed or retryable Top-Up Provider Event',
      description: 'Resets a retryable Top-Up provider event back to RECEIVED status so the worker can process it again.',
      operationId: 'retryTopUpProviderEvent',
      security: betterAuthSecurity,
    },
  });
