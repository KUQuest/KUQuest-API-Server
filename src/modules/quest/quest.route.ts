import { authGuard } from '@/modules/auth';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { API_V1_PREFIX } from '@/shared/api-version';
import { rejectUnknownFields } from '@/shared/reject-unknown-fields';

import { Elysia } from 'elysia';

import {
  createQuestController,
  getQuestDetailController,
  listBoardQuestsController,
  listOwnQuestsController,
} from './quest.controller';
import {
  questBoardResponseSchema,
  questCreateResponseSchema,
  questCreateSchema,
  questDetailResponseSchema,
  questListQuerySchema,
  questMineQuerySchema,
  questMineResponseSchema,
  questParamsSchema,
} from './quest.schema';

export const questRoute = new Elysia({
  name: 'quest-route',
  prefix: `${API_V1_PREFIX}/quests`,
})
  .use(authGuard)
  .post('', createQuestController, {
    body: questCreateSchema,
    transform: rejectUnknownFields(questCreateSchema),
    response: responses(questCreateResponseSchema, 400, 401),
    detail: {
      tags: ['Quests'],
      summary: 'Create a Quest Draft',
      description: 'Creates a Draft Quest owned by the authenticated Member as Hirer.',
      operationId: 'createQuest',
      security: betterAuthSecurity,
    },
  })
  .get('/mine', listOwnQuestsController, {
    query: questMineQuerySchema,
    response: responses(questMineResponseSchema, 400, 401),
    detail: {
      tags: ['Quests'],
      summary: "List the Hirer's Quests",
      description: 'Returns the authenticated Hirer’s Quests across all Quest Status values.',
      operationId: 'listOwnQuests',
      security: betterAuthSecurity,
    },
  })
  .get('/:questId', getQuestDetailController, {
    params: questParamsSchema,
    response: responses(questDetailResponseSchema, 400, 401, 404),
    detail: {
      tags: ['Quests'],
      summary: 'Get Quest detail',
      description: 'Returns full detail for an owned Quest or an OPEN Quest visible to the caller.',
      operationId: 'getQuestDetail',
      security: betterAuthSecurity,
    },
  })
  .get('', listBoardQuestsController, {
    query: questListQuerySchema,
    response: responses(questBoardResponseSchema, 400, 401),
    detail: {
      tags: ['Quests'],
      summary: 'Search the Quest Board',
      description: 'Returns OPEN Quest cards with filters, search, and cursor paging.',
      operationId: 'listQuestBoard',
      security: betterAuthSecurity,
    },
  });
