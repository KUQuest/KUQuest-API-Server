import { authGuard } from '@/modules/auth';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { API_V2_PREFIX } from '@/shared/api-version';

import { Elysia } from 'elysia';

import {
  addQuestImagesV2Controller,
  createQuestV2Controller,
  createQuestV2EditRequestController,
  deleteQuestImageV2Controller,
  editQuestV2Controller,
  getPublicQuestV2DetailController,
  getQuestV2DetailController,
  getQuestV2PublishCheckController,
  getQuestV2EditRequestController,
  listOwnQuestV2Controller,
  listQuestBoardV2Controller,
  publishQuestV2Controller,
  respondToQuestV2EditRequestController,
} from './quest-v2.controller';
import { createQuestIdempotencyKeyGuard } from './quest-idempotency.guard';
import {
  cancelQuestV2Controller,
} from './quest-settlement.controller';
import {
  questCancellationResponseSchema,
} from './quest-settlement.schema';
import {
  questV2CreateHttpResponseSchema,
  questV2CreateHttpSchema,
  questV2BoardQueryHttpSchema,
  questV2BoardResponseSchema,
  questV2DetailHttpResponseSchema,
  questV2EditHeadersSchema,
  questV2EditHttpSchema,
  questV2EditHttpResponseSchema,
  questV2MineQuerySchema,
  questV2MineHttpResponseSchema,
  questV2ImageParamsSchema,
  questV2ImagesResponseSchema,
  questV2ImagesUploadSchema,
  questV2ParamsSchema,
  questV2PublicDetailResponseSchema,
  questV2PublishCheckHttpResponseSchema,
  questV2PublishHttpResponseSchema,
  questV2WriteHeadersSchema,
  normalizeQuestV2CreateBody,
  normalizeQuestV2BoardQuery,
  normalizeQuestV2EditBody,
  normalizeQuestV2EditRequestCreateBody,
  normalizeQuestV2EditRequestResponseBody,
  questV2EditRequestCreateSchema,
  questV2EditRequestParamsSchema,
  questV2EditRequestResponseInputSchema,
  questV2EditRequestResponseSchema,
} from './quest-v2.schema';

export const questV2Route = new Elysia({
  name: 'quest-v2-route',
  prefix: `${API_V2_PREFIX}/quests`,
})
  .use(createQuestIdempotencyKeyGuard('quest-cancellation'))
  .use(authGuard)
  .get('', listQuestBoardV2Controller, {
    query: questV2BoardQueryHttpSchema,
    transform: normalizeQuestV2BoardQuery,
    response: responses(questV2BoardResponseSchema, 400, 401, 500),
    detail: {
      tags: ['Quests v2'],
      summary: 'List the v2 Quest Board',
      description:
        'Returns compact Quest Board Cards for non-hidden, open, joinable Quests owned by another Member. Eligibility is evaluated before cursor pagination.',
      operationId: 'listQuestBoardV2',
      security: betterAuthSecurity,
    },
  })
  .post('', createQuestV2Controller, {
    body: questV2CreateHttpSchema,
    headers: questV2WriteHeadersSchema,
    transform: normalizeQuestV2CreateBody,
    response: responses(questV2CreateHttpResponseSchema, 400, 401, 409, 500, 503),
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
    response: responses(questV2MineHttpResponseSchema, 400, 401, 500),
    detail: {
      tags: ['Quests v2'],
      summary: 'List the Hirer\'s v2 Quests',
      description: 'Returns the authenticated Hirer’s Quests owned through the v2 contract.',
      operationId: 'listOwnQuestsV2',
      security: betterAuthSecurity,
    },
  })
  .post('/:questId/edit-requests', createQuestV2EditRequestController, {
    params: questV2ParamsSchema,
    body: questV2EditRequestCreateSchema,
    headers: questV2WriteHeadersSchema,
    transform: normalizeQuestV2EditRequestCreateBody,
    response: responses(questV2EditRequestResponseSchema, { successStatus: 201 }, 400, 401, 404, 409, 500, 503),
    detail: {
      tags: ['Quests v2'],
      summary: 'Create a v2 Quest Edit Request',
      description:
        'Creates a ten-minute Condition replacement request for every Active Worker on an assigned v2 Quest. The request does not pause the Quest or change other Quest fields.',
      operationId: 'createQuestEditRequestV2',
      security: betterAuthSecurity,
    },
  })
  .get('/edit-requests/:requestId', getQuestV2EditRequestController, {
    params: questV2EditRequestParamsSchema,
    response: responses(questV2EditRequestResponseSchema, 400, 401, 404, 500),
    detail: {
      tags: ['Quests v2'],
      summary: 'Get a v2 Quest Edit Request',
      description:
        'Returns the Quest Edit Request to the Hirer or an Active Worker. Worker responses include only that Worker’s response and the aggregate summary.',
      operationId: 'getQuestEditRequestV2',
      security: betterAuthSecurity,
    },
  })
  .post('/edit-requests/:requestId/respond', respondToQuestV2EditRequestController, {
    params: questV2EditRequestParamsSchema,
    body: questV2EditRequestResponseInputSchema,
    headers: questV2WriteHeadersSchema,
    transform: normalizeQuestV2EditRequestResponseBody,
    response: responses(questV2EditRequestResponseSchema, 400, 401, 404, 409, 500, 503),
    detail: {
      tags: ['Quests v2'],
      summary: 'Respond to a v2 Quest Edit Request',
      description:
        'Records one Active Worker response. The final acceptance applies the proposed Condition atomically; a decline fails the request and preserves the previous Condition.',
      operationId: 'respondToQuestEditRequestV2',
      security: betterAuthSecurity,
    },
  })
  .patch('/:questId', editQuestV2Controller, {
    params: questV2ParamsSchema,
    body: questV2EditHttpSchema,
    headers: questV2EditHeadersSchema,
    transform: normalizeQuestV2EditBody,
    response: responses(questV2EditHttpResponseSchema, 400, 401, 404, 409, 500, 503),
    detail: {
      tags: ['Quests v2'],
      summary: 'Edit a v2 Quest Draft',
      description:
        'Updates the supplied fields of an owned QUEST_DRAFT with optimistic concurrency.',
      operationId: 'editQuestV2Draft',
      security: betterAuthSecurity,
    },
  })
  .post('/:questId/images', addQuestImagesV2Controller, {
    params: questV2ParamsSchema,
    body: questV2ImagesUploadSchema,
    headers: questV2WriteHeadersSchema,
    type: 'multipart/form-data',
    response: responses(questV2ImagesResponseSchema, 400, 401, 404, 409, 413, 415, 500, 503),
    detail: {
      tags: ['Quests v2'],
      summary: 'Add Quest Images to a v2 Draft',
      description:
        'Accepts a multipart images field with one to three validated JPEG, PNG, or WebP files of at most 5 MB each. Appends files to the authenticated Hirer’s QUEST_DRAFT in request order and returns imageId, fileId, position, url, and urlExpiresAt for the complete ordered gallery. A retry with the same Idempotency-Key replays the original response; temporary links expire 15 minutes after materialization, so use Quest detail for a fresh link.',
      operationId: 'addQuestImagesV2',
      security: betterAuthSecurity,
    },
  })
  .delete('/:questId/images/:imageId', deleteQuestImageV2Controller, {
    params: questV2ImageParamsSchema,
    headers: questV2WriteHeadersSchema,
    response: responses(questV2ImagesResponseSchema, 400, 401, 404, 409, 500, 503),
    detail: {
      tags: ['Quests v2'],
      summary: 'Remove a Quest Image from a v2 Draft',
      description:
        'Removes one Quest Image by imageId, soft-deletes its file metadata, repacks the remaining positions from zero, and returns imageId, fileId, position, url, and urlExpiresAt for the complete ordered gallery. A retry with the same Idempotency-Key replays the original response; temporary links expire 15 minutes after materialization, so use Quest detail for a fresh link.',
      operationId: 'deleteQuestImageV2',
      security: betterAuthSecurity,
    },
  })
  .post('/:questId/publish', publishQuestV2Controller, {
    params: questV2ParamsSchema,
    headers: questV2WriteHeadersSchema,
    response: responses(questV2PublishHttpResponseSchema, 400, 401, 404, 409, 500, 503),
    detail: {
      tags: ['Quests v2'],
      summary: 'Publish a v2 Quest Draft',
      description:
        'Rechecks the owned Draft and reserves the exact inclusive Quest Funding Total for every headcount slot before changing the Quest to QUEST_OPEN. The request has no business body and requires Idempotency-Key.',
      operationId: 'publishQuestV2',
      security: betterAuthSecurity,
    },
  })
  .post('/:questId/cancel', cancelQuestV2Controller, {
    params: questV2ParamsSchema,
    headers: questV2WriteHeadersSchema,
    response: responses(questCancellationResponseSchema, 400, 401, 403, 404, 409, 503),
    detail: {
      tags: ['Quests v2'],
      summary: 'Cancel a v2 Quest as its Hirer',
      description:
        'Cancels a v2 Quest from Draft, Open, Assigned, or In Progress. The command has no business request body and applies the stage-specific Quest Escrow settlement atomically.',
      operationId: 'cancelQuestV2',
      security: betterAuthSecurity,
    },
  })
  .get('/:questId/publish-check', getQuestV2PublishCheckController, {
    params: questV2ParamsSchema,
    response: responses(questV2PublishCheckHttpResponseSchema, 400, 401, 404, 409, 500, 503),
    detail: {
      tags: ['Quests v2'],
      summary: 'Check whether a v2 Quest Draft can be published',
      description:
        'Returns publish blockers, warnings, and the inclusive Quest Funding Total quote for the Hirer without changing Quest or Wallet state.',
      operationId: 'getQuestV2PublishCheck',
      security: betterAuthSecurity,
    },
  })
  .get('/:questId/public', getPublicQuestV2DetailController, {
    params: questV2ParamsSchema,
    response: responses(questV2PublicDetailResponseSchema, 400, 401, 404, 500, 503),
    detail: {
      tags: ['Quests v2'],
      summary: 'Get Public Quest Detail through the v2 contract',
      description:
        'Returns the public projection of a non-hidden QUEST_OPEN Quest to an authenticated Member who is not the Hirer. Candidate and Finance internals are excluded.',
      operationId: 'getPublicQuestV2Detail',
      security: betterAuthSecurity,
    },
  })
  .get('/:questId', getQuestV2DetailController, {
    params: questV2ParamsSchema,
    response: responses(questV2DetailHttpResponseSchema, 400, 401, 404, 500, 503),
    detail: {
      tags: ['Quests v2'],
      summary: 'Get a v2 Quest detail',
      description: 'Returns a Quest owned by the authenticated Hirer through the v2 contract.',
      operationId: 'getQuestV2Detail',
      security: betterAuthSecurity,
    },
  });
