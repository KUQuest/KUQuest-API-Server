import { authGuard } from '@/modules/auth';
import { apiSuccessSchema, betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { API_V1_PREFIX } from '@/shared/api-version';
import { rejectUnknownFields } from '@/shared/reject-unknown-fields';

import { Elysia } from 'elysia';

import {
  addQuestImagesController,
  createQuestController,
  createQuestEditRequestController,
  deleteQuestImageController,
  editQuestController,
  getQuestDetailController,
  getQuestPublishCheckController,
  listBoardQuestsController,
  listOwnQuestsController,
  publishQuestController,
  getQuestEditRequestController,
  respondToQuestEditRequestController,
} from './quest.controller';
import {
  questBoardResponseSchema,
  questCreateResponseSchema,
  questCreateSchema,
  questDetailResponseSchema,
  questEditDecisionSchema,
  questEditRequestCreateResponseSchema,
  questEditRequestParamsSchema,
  questEditRequestResponseSchema,
  questEditResponseSchema,
  questDirectEditSchema,
  questEditSchema,
  questImageParamsSchema,
  questImagesUploadResponseSchema,
  questImagesUploadSchema,
  questListQuerySchema,
  questMineQuerySchema,
  questMineResponseSchema,
  questParamsSchema,
  questPublishCheckResponseSchema,
  questPublishResponseSchema,
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
  .get('/:questId/publish-check', getQuestPublishCheckController, {
    params: questParamsSchema,
    response: responses(questPublishCheckResponseSchema, 401, 404, 409),
    detail: {
      tags: ['Quests'],
      summary: 'Check whether a Quest Draft can be published',
      description: 'Returns publish blockers, warnings, and the required Escrow amount for the Hirer.',
      operationId: 'getQuestPublishCheck',
      security: betterAuthSecurity,
    },
  })
  .post('/:questId/publish', publishQuestController, {
    params: questParamsSchema,
    response: responses(questPublishResponseSchema, 401, 404, 409, 503),
    detail: {
      tags: ['Quests'],
      summary: 'Publish a Quest Draft',
      description:
        'Reserves Quest Escrow for the authenticated Hirer, then moves the Quest from QUEST_DRAFT to QUEST_OPEN.',
      operationId: 'publishQuest',
      security: betterAuthSecurity,
    },
  })
  .patch('/:questId', editQuestController, {
    params: questParamsSchema,
    body: questDirectEditSchema,
    transform: rejectUnknownFields(questDirectEditSchema),
    response: responses(questDetailResponseSchema, 400, 401, 404, 409, 502),
    detail: {
      tags: ['Quests'],
      summary: 'Edit an eligible Draft or QUEST_OPEN Quest before participation starts',
      description:
        'Updates the supplied fields of an eligible Draft or QUEST_OPEN Quest owned by the authenticated Hirer when no Candidate exists and no Worker or Team has been selected.',
      operationId: 'editQuest',
      security: betterAuthSecurity,
    },
  })
  .post('/:questId/edit-requests', createQuestEditRequestController, {
    params: questParamsSchema,
    body: questEditSchema,
    transform: rejectUnknownFields(questEditSchema),
    response: responses(questEditRequestCreateResponseSchema, 400, 401, 404, 409),
    detail: {
      tags: ['Quests'],
      summary: 'Request consent for a post-Assignment Quest edit',
      description: 'Pauses an assigned Quest and asks every Active Worker to approve the proposed mutable changes within five minutes.',
      operationId: 'createQuestEditRequest',
      security: betterAuthSecurity,
    },
  })
  .get('/edit-requests/:requestId', getQuestEditRequestController, {
    params: questEditRequestParamsSchema,
    response: responses(questEditRequestResponseSchema, 401, 404),
    detail: {
      tags: ['Quests'],
      summary: 'Get a Quest edit consent request',
      operationId: 'getQuestEditRequest',
      security: betterAuthSecurity,
    },
  })
  .post('/edit-requests/:requestId/respond', respondToQuestEditRequestController, {
    params: questEditRequestParamsSchema,
    body: questEditDecisionSchema,
    transform: rejectUnknownFields(questEditDecisionSchema),
    response: responses(questEditResponseSchema, 401, 404, 409),
    detail: {
      tags: ['Quests'],
      summary: 'Respond to a Quest edit consent request',
      operationId: 'respondToQuestEditRequest',
      security: betterAuthSecurity,
    },
  })
  .post('/:questId/images', addQuestImagesController, {
    params: questParamsSchema,
    body: questImagesUploadSchema,
    type: 'multipart/form-data',
    response: responses(questImagesUploadResponseSchema, 400, 401, 404, 409, 413, 415, 502),
    detail: {
      tags: ['Quests'],
      summary: 'Add images to a Quest Draft',
      description: 'Adds up to 3 total images to the authenticated Hirer’s Draft Quest.',
      operationId: 'addQuestImages',
      security: betterAuthSecurity,
    },
  })
  .delete('/:questId/images/:imageId', deleteQuestImageController, {
    params: questImageParamsSchema,
    response: responses(apiSuccessSchema, 401, 404, 409),
    detail: {
      tags: ['Quests'],
      summary: 'Delete a Quest Image',
      description: 'Deletes one image from the authenticated Hirer’s Draft Quest.',
      operationId: 'deleteQuestImage',
      security: betterAuthSecurity,
    },
  })
  .get('/:questId', getQuestDetailController, {
    params: questParamsSchema,
    response: responses(questDetailResponseSchema, 400, 401, 404, 502),
    detail: {
      tags: ['Quests'],
      summary: 'Get Quest detail',
      description: 'Returns full detail for an owned Quest or a QUEST_OPEN Quest visible to the caller.',
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
      description: 'Returns QUEST_OPEN Quest cards with filters, search, and cursor paging.',
      operationId: 'listQuestBoard',
      security: betterAuthSecurity,
    },
  });
