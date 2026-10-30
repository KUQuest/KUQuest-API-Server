import { authGuard, memberBanGuard } from '@/modules/auth';
import { API_V1_PREFIX } from '@/shared/api-version';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';

import { Elysia } from 'elysia';

import {
  fileAdminDisputeCaseController,
  respondToQuestDisputeController,
} from './quest-dispute-admin.controller';
import {
  adminDisputeParamsSchema,
  adminDisputeOpenParamsSchema,
  adminDisputeOpenResponseSchema,
  questDisputeFilingBodySchema,
  questDisputeMineResponseSchema,
  questDisputeResponseBodySchema,
} from './quest-dispute-admin.schema';
import { summaryFromRecord } from './quest-dispute-admin.service';
import {
  getQuestDisputeTeamSplitController,
  submitQuestDisputeTeamSplitController,
} from './quest-dispute-team-split.controller';
import {
  questDisputeTeamSplitBodySchema,
  questDisputeTeamSplitHeadersSchema,
  questDisputeTeamSplitParamsSchema,
  questDisputeTeamSplitResponseSchema,
} from './quest-dispute-team-split.schema';
import { db } from '@/database/client';
import { adminDisputeCase } from '@/database/schema/admin.schema';
import { and, eq } from 'drizzle-orm';

export const questDisputeRoute = new Elysia({
  name: 'quest-dispute-route',
  prefix: `${API_V1_PREFIX}/quests`,
})
  .use(authGuard)
  .use(memberBanGuard)
  .post('/:questId/disputes', fileAdminDisputeCaseController, {
    params: adminDisputeOpenParamsSchema,
    body: questDisputeFilingBodySchema,
    response: responses(adminDisputeOpenResponseSchema, 400, 401, 403, 404, 409),
    detail: {
      tags: ['Quest Disputes'],
      summary: 'File a Dispute Case as the Hirer or Worker',
      description:
        'Files one Dispute Case for the authenticated Hirer or an assigned Worker on a Quest with a money hold (QUEST_FAILED, or QUEST_COMPLETED with an unpaid slot) within the one-day self-file window. In GROUP + CANDIDATE, only the Team Leader can file. The Member supplies the required category and submittedDetail and may supply filerStatement.',
      operationId: 'fileQuestDispute',
      security: betterAuthSecurity,
    },
  })
  .get('/:questId/disputes/team-split', getQuestDisputeTeamSplitController, {
    params: questDisputeTeamSplitParamsSchema,
    response: responses(questDisputeTeamSplitResponseSchema, 401, 404, 409),
    detail: {
      tags: ['Quest Disputes'],
      summary: 'Read the split of a team Dispute Case',
      description:
        'A selected Candidate Team member reads the Admin-approved amount, the split deadline, each member share, and the payment state of the team Dispute Case. The Quest `dispute` object carries the same state and `viewerRole` for the app screen. A Member outside the Team receives 404.',
      operationId: 'getQuestDisputeTeamSplit',
      security: betterAuthSecurity,
    },
  })
  .post('/:questId/disputes/team-split', submitQuestDisputeTeamSplitController, {
    params: questDisputeTeamSplitParamsSchema,
    body: questDisputeTeamSplitBodySchema,
    headers: questDisputeTeamSplitHeadersSchema,
    response: responses(questDisputeTeamSplitResponseSchema, 400, 401, 403, 404, 409, 503),
    detail: {
      tags: ['Quest Disputes'],
      summary: 'Confirm the split of a team Dispute Case',
      description:
        'Only the Team Leader confirms the share of every Team member, the Leader included, as integer basis points that total 10000, within 24 hours after the Admin approves the amount. The Server splits the approved Satang by largest remainder and pays each member from the Quest hold, or from the Hirer Spending Balance after the hold ended. If the Wallet cannot pay the whole split, the split stays confirmed with `paymentPending` true and the Server retries. Without a split in time, the Server splits equally.',
      operationId: 'submitQuestDisputeTeamSplit',
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

export const disputeCaseResponseRoute = new Elysia({
  name: 'dispute-case-response-route',
  prefix: `${API_V1_PREFIX}/disputes`,
})
  .use(authGuard)
  .use(memberBanGuard)
  .post('/:disputeCaseId/respond', respondToQuestDisputeController, {
    params: adminDisputeParamsSchema,
    body: questDisputeResponseBodySchema,
    response: responses(adminDisputeOpenResponseSchema, 400, 401, 403, 404, 409),
    detail: {
      tags: ['Quest Disputes'],
      summary: 'Submit a respondent statement for a Dispute Case',
      description:
        'Lets the opposing Member submit one statement while the Quest has a money hold and the Dispute Case is DISPUTE_CASE_PENDING, no later than seven days after the hold started.',
      operationId: 'respondToDisputeCase',
      security: betterAuthSecurity,
    },
  });
