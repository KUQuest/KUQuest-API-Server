import { authGuard } from '@/modules/auth';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { API_V2_PREFIX } from '@/shared/api-version';

import { Elysia } from 'elysia';

import {
  createQuestV2Controller,
  getQuestV2DetailController,
  listOwnQuestV2Controller,
} from './quest-v2.controller';
import {
  questV2CreateResponseSchema,
  questV2CreateHttpSchema,
  questV2DetailResponseSchema,
  questV2MineQuerySchema,
  questV2MineResponseSchema,
  questV2ParamsSchema,
  questV2WriteHeadersSchema,
  normalizeQuestV2CreateBody,
} from './quest-v2.schema';

export const questV2Route = new Elysia({
  name: 'quest-v2-route',
  prefix: `${API_V2_PREFIX}/quests`,
})
  .use(authGuard)
  .post('', createQuestV2Controller, {
    body: questV2CreateHttpSchema,
    headers: questV2WriteHeadersSchema,
    transform: normalizeQuestV2CreateBody,
    response: responses(questV2CreateResponseSchema, 400, 401, 409, 500, 503),
    detail: {
      tags: ['Quests v2'],
      summary: 'Create a Quest Draft with the v2 contract',
      description: 'Creates a QUEST_DRAFT owned by the authenticated Member as Hirer.',
      operationId: 'createQuestV2',
      security: betterAuthSecurity,
    },
  })
  .get('/mine', listOwnQuestV2Controller, {
    query: questV2MineQuerySchema,
    response: responses(questV2MineResponseSchema, 400, 401, 500),
    detail: {
      tags: ['Quests v2'],
      summary: 'List the Hirer\'s v2 Quests',
      description: 'Returns the authenticated Hirer’s Quests owned through the v2 contract.',
      operationId: 'listOwnQuestsV2',
      security: betterAuthSecurity,
    },
  })
  .get('/:questId', getQuestV2DetailController, {
    params: questV2ParamsSchema,
    response: responses(questV2DetailResponseSchema, 400, 401, 404, 500),
    detail: {
      tags: ['Quests v2'],
      summary: 'Get a v2 Quest detail',
      description: 'Returns a Quest owned by the authenticated Hirer through the v2 contract.',
      operationId: 'getQuestV2Detail',
      security: betterAuthSecurity,
    },
  });
