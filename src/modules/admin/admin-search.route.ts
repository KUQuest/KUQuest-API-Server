import { enabledAdminGuard } from '@/modules/auth';
import { API_V1_PREFIX } from '@/shared/api-version';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';

import { Elysia } from 'elysia';

import { searchAdminController } from './admin-search.controller';
import { adminSearchQuerySchema, adminSearchResponseSchema } from './admin-search.schema';

export const adminSearchRoute = new Elysia({
  name: 'admin-search-route',
  prefix: `${API_V1_PREFIX}/admin`,
})
  .use(enabledAdminGuard)
  .get('/search', searchAdminController, {
    query: adminSearchQuerySchema,
    response: responses(adminSearchResponseSchema, 400, 401, 403, 429, 500),
    detail: {
      tags: ['Admin Search'],
      summary: 'Search Admin Records',
      description:
        'Searches Members, Quests, Payouts, Dispute Cases, Report Cases, Conduct Reports, Wallets, and Admin Activity Logs. It searches safe record fields only. Message text, Attachments, chat history, Evidence content, Payout Destination details, and Provider payloads are excluded.',
      operationId: 'searchAdminRecords',
      security: betterAuthSecurity,
    },
  });
