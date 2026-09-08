import { enabledAdminGuard } from '@/modules/auth';
import { API_V1_PREFIX } from '@/shared/api-version';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';

import { Elysia } from 'elysia';

import {
  getAdminOverviewController,
  listAdminActivityController,
} from './admin-overview.controller';
import {
  adminActivityListQuerySchema,
  adminActivityListResponseSchema,
  adminOverviewResponseSchema,
} from './admin-overview.schema';

export const adminOverviewRoute = new Elysia({
  name: 'admin-overview-route',
  prefix: `${API_V1_PREFIX}/admin`,
})
  .use(enabledAdminGuard)
  .get('/overview', getAdminOverviewController, {
    response: responses(adminOverviewResponseSchema, 401, 403),
    detail: {
      tags: ['Admin Overview'],
      summary: 'Read the Admin queue counters',
      description: 'Counts the Quest, Dispute, Payout, and Member queues. The Report queue has no persistence yet, so it is absent.',
      operationId: 'getAdminOverview',
      security: betterAuthSecurity,
    },
  })
  .get('/activity-log', listAdminActivityController, {
    query: adminActivityListQuerySchema,
    response: responses(adminActivityListResponseSchema, 400, 401, 403),
    detail: {
      tags: ['Admin Overview'],
      summary: 'List the Admin Action Activity Log',
      description: 'Lists immutable Admin Actions with bounded cursor pagination. Evidence, credentials, tokens, signed URLs, and Admin Action metadata stay out of the projection.',
      operationId: 'listAdminActivityLog',
      security: betterAuthSecurity,
    },
  });
