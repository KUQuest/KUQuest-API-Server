import { enabledAdminGuard } from '@/modules/auth';
import { API_V1_PREFIX } from '@/shared/api-version';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';

import { Elysia } from 'elysia';

import { getAdminQuestDetailController, listAdminQuestsController } from './quest-admin.controller';
import {
  adminQuestDetailResponseSchema,
  adminQuestListQuerySchema,
  adminQuestListResponseSchema,
  adminQuestParamsSchema,
} from './quest-admin.schema';

export const adminQuestRoute = new Elysia({
  name: 'admin-quest-route',
  prefix: `${API_V1_PREFIX}/admin/quests`,
})
  .use(enabledAdminGuard)
  .get('', listAdminQuestsController, {
    query: adminQuestListQuerySchema,
    response: responses(adminQuestListResponseSchema, 400, 401, 403),
    detail: {
      tags: ['Admin Quests'],
      summary: 'List Quests for Admin review',
      description: 'Lists Quests across every state, mode, and participation shape, including hidden Quests, using bounded cursor pagination and safe filters.',
      operationId: 'listAdminQuests',
      security: betterAuthSecurity,
    },
  })
  .get('/:questId', getAdminQuestDetailController, {
    params: adminQuestParamsSchema,
    response: responses(adminQuestDetailResponseSchema, 401, 403, 404),
    detail: {
      tags: ['Admin Quests'],
      summary: 'Get Quest detail for Admin review',
      description: 'Reads Quest facts, Hirer, Candidates, Workers, Assignments, proof and file references, financial facts, edit history, and Admin Action history without secrets or unrelated Member data.',
      operationId: 'getAdminQuestDetail',
      security: betterAuthSecurity,
    },
  });
