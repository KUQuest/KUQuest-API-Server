import { authGuard, memberBanGuard } from '@/modules/auth';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { API_V2_PREFIX } from '@/shared/api-version';
import { rejectUnknownFields } from '@/shared/reject-unknown-fields';

import { Elysia } from 'elysia';

import {
  getQuestV2RewardAllocationController,
  submitQuestV2RewardAllocationController,
} from './quest-v2-reward-allocation.controller';
import {
  questV2RewardAllocationHeadersSchema,
  questV2RewardAllocationParamsSchema,
  questV2RewardAllocationRequestSchema,
  questV2RewardAllocationResponseSchema,
} from './quest-v2-reward-allocation.schema';

export const questV2RewardAllocationRoute = new Elysia({
  name: 'quest-v2-reward-allocation-route',
  prefix: API_V2_PREFIX,
})
  .use(authGuard)
  .use(memberBanGuard)
  .get('/quests/:questId/reward-allocation', getQuestV2RewardAllocationController, {
    params: questV2RewardAllocationParamsSchema,
    response: responses(questV2RewardAllocationResponseSchema, 401, 404, 409, 500),
    detail: {
      tags: ['Quest Reward Allocation v2'],
      summary: 'Read a completed Candidate Team Reward Allocation',
      description:
        'A selected Candidate Team Member can read the pending or settled Reward Allocation after the Quest completes. The response shows the Worker Reward pool and each Member share, but no Platform Fee or Wallet details.',
      operationId: 'getQuestV2RewardAllocation',
      security: betterAuthSecurity,
    },
  })
  .post('/quests/:questId/reward-allocation', submitQuestV2RewardAllocationController, {
    params: questV2RewardAllocationParamsSchema,
    body: questV2RewardAllocationRequestSchema,
    headers: questV2RewardAllocationHeadersSchema,
    transform: rejectUnknownFields(questV2RewardAllocationRequestSchema),
    response: responses(questV2RewardAllocationResponseSchema, 400, 401, 403, 404, 409, 503),
    detail: {
      tags: ['Quest Reward Allocation v2'],
      summary: 'Submit a Candidate Team Reward Allocation',
      description:
        'Only the Team Leader can submit percentages for every teammate within 24 hours after successful completion. The Leader receives the remaining percentage and the Server settles the full Quest Reward pool atomically.',
      operationId: 'submitQuestV2RewardAllocation',
      security: betterAuthSecurity,
    },
  });
