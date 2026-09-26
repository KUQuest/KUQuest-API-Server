import { authGuard } from '@/modules/auth';
import { API_V1_PREFIX } from '@/shared/api-version';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';

import { Elysia } from 'elysia';

import { fileAdminDisputeCaseController } from './quest-dispute-admin.controller';
import {
  adminDisputeOpenParamsSchema,
  adminDisputeOpenResponseSchema,
  questDisputeMineResponseSchema,
} from './quest-dispute-admin.schema';
import { summaryFromRecord } from './quest-dispute-admin.service';
import { db } from '@/database/client';
import { adminDisputeCase } from '@/database/schema/admin.schema';
import { and, eq } from 'drizzle-orm';

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
  })
  .get(
    '/:questId/disputes/mine',
    async ({ params, session }) => {
      const [row] = await db
        .select()
        .from(adminDisputeCase)
        .where(
          and(
            eq(adminDisputeCase.questId, params.questId),
            eq(adminDisputeCase.filerUserId, session.user.id)
          )
        )
        .limit(1);
      return {
        success: true,
        data: {
          case: row ? summaryFromRecord(row) : null,
        },
      };
    },
    {
      params: adminDisputeOpenParamsSchema,
      response: responses(questDisputeMineResponseSchema, 401, 500),
      detail: {
        tags: ['Quest Disputes'],
        summary: "Read authenticated Member's filed Dispute Case on a Quest",
        description:
          'Returns the Dispute Case filed by the authenticated Member on this Quest, or null if none exists.',
        operationId: 'getMyQuestDisputeCase',
        security: betterAuthSecurity,
      },
    }
  );
