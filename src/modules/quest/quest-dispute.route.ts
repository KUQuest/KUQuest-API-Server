import { authGuard } from '@/modules/auth';
import { API_V1_PREFIX } from '@/shared/api-version';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';

import { Elysia } from 'elysia';

import { fileAdminDisputeCaseController } from './quest-dispute-admin.controller';
import {
  adminDisputeOpenParamsSchema,
  adminDisputeOpenResponseSchema,
} from './quest-dispute-admin.schema';

export const questDisputeRoute = new Elysia({
  name: 'quest-dispute-route',
  prefix: `${API_V1_PREFIX}/quests`,
})
  .use(authGuard)
  .post('/:questId/disputes', fileAdminDisputeCaseController, {
    params: adminDisputeOpenParamsSchema,
    response: responses(adminDisputeOpenResponseSchema, 400, 401, 404, 409),
    detail: {
      tags: ['Quest Disputes'],
      summary: 'File a Dispute Case as the Hirer or Worker',
      description:
        'Files one Dispute Case for the authenticated Hirer or an assigned Worker on a failed Quest within the one-day self-file window.',
      operationId: 'fileQuestDispute',
      security: betterAuthSecurity,
    },
  });
