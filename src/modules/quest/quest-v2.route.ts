import { authGuard } from '@/modules/auth';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { API_V2_PREFIX } from '@/shared/api-version';

import { Elysia } from 'elysia';

import {
  addQuestImagesV2Controller,
  createQuestV2Controller,
  deleteQuestImageV2Controller,
  editQuestV2Controller,
  getQuestV2DetailController,
  getQuestV2PublishCheckController,
  listOwnQuestV2Controller,
  publishQuestV2Controller,
} from './quest-v2.controller';
import {
  questV2CreateResponseSchema,
  questV2CreateHttpSchema,
  questV2DetailResponseSchema,
  questV2EditHeadersSchema,
  questV2EditHttpSchema,
  questV2EditResponseSchema,
  questV2MineQuerySchema,
  questV2MineResponseSchema,
  questV2ImageParamsSchema,
  questV2ImagesResponseSchema,
  questV2ImagesUploadSchema,
  questV2ParamsSchema,
  questV2PublishCheckHttpResponseSchema,
  questV2PublishHttpResponseSchema,
  questV2WriteHeadersSchema,
  normalizeQuestV2CreateBody,
  normalizeQuestV2EditBody,
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
  .patch('/:questId', editQuestV2Controller, {
    params: questV2ParamsSchema,
    body: questV2EditHttpSchema,
    headers: questV2EditHeadersSchema,
    transform: normalizeQuestV2EditBody,
    response: responses(questV2EditResponseSchema, 400, 401, 404, 409, 500, 503),
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
  .get('/:questId', getQuestV2DetailController, {
    params: questV2ParamsSchema,
    response: responses(questV2DetailResponseSchema, 400, 401, 404, 500, 503),
    detail: {
      tags: ['Quests v2'],
      summary: 'Get a v2 Quest detail',
      description: 'Returns a Quest owned by the authenticated Hirer through the v2 contract.',
      operationId: 'getQuestV2Detail',
      security: betterAuthSecurity,
    },
  });
