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
      description:
        'Counts Quest States, hidden Quests, Dispute Cases, Payouts, open Report Cases and Conduct Reports, Member and Wallet statuses, and the oldest item in each review queue.',
      operationId: 'getAdminOverview',
      security: betterAuthSecurity,
    },
  });
