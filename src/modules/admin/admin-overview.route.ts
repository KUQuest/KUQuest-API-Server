import { enabledAdminGuard } from '@/modules/auth';
import { API_V1_PREFIX } from '@/shared/api-version';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';

import { Elysia } from 'elysia';

import { getAdminOverviewController } from './admin-overview.controller';
import { adminOverviewResponseSchema } from './admin-overview.schema';

export const adminOverviewRoute = new Elysia({
  name: 'admin-overview-route',
  prefix: `${API_V1_PREFIX}/admin`,
})
  .use(enabledAdminGuard)
  .get('/overview', getAdminOverviewController, {
    response: responses(adminOverviewResponseSchema, 401, 403),
    detail: {
      tags: ['Admin Overview'],
      summary: 'Read Admin operational counters',
      description: 'Counts Quest States, the Hidden Quest overlay, Dispute Cases, Payout queues, and Wallet holds. The Report counter is absent because Report Case persistence is unavailable.',
      operationId: 'getAdminOverview',
      security: betterAuthSecurity,
    },
  });
