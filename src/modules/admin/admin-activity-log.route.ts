import { enabledAdminGuard } from '@/modules/auth';
import { API_V1_PREFIX } from '@/shared/api-version';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';

import { Elysia } from 'elysia';

import { listAdminActivityController } from './admin-activity-log.controller';
import {
  adminActivityListQuerySchema,
  adminActivityListResponseSchema,
} from './admin-activity-log.schema';

export const adminActivityLogRoute = new Elysia({
  name: 'admin-activity-log-route',
  prefix: `${API_V1_PREFIX}/admin`,
})
  .use(enabledAdminGuard)
  .get('/activity-log', listAdminActivityController, {
    query: adminActivityListQuerySchema,
    response: responses(adminActivityListResponseSchema, 400, 401, 403),
    detail: {
      tags: ['Admin Activity Log'],
      summary: 'List the Admin Action Activity Log',
      description: 'Lists immutable Admin Actions with bounded cursor pagination. Evidence, credentials, tokens, signed URLs, and request data stay out of the projection.',
      operationId: 'listAdminActivityLog',
      security: betterAuthSecurity,
    },
  });
