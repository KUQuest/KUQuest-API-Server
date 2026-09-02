import { authGuard } from '@/modules/auth';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { API_V2_PREFIX } from '@/shared/api-version';

import { Elysia } from 'elysia';

import {
  createQuestV2CandidateApplicationController,
  getQuestV2CandidateApplicationController,
  listQuestV2CandidateApplicationsController,
  selectQuestV2CandidateApplicationController,
  withdrawQuestV2CandidateApplicationController,
} from './quest-candidate-v2.controller';
import {
  questV2CandidateApplicationHeadersSchema,
  questV2CandidateApplicationDetailParamsSchema,
  questV2CandidateApplicationListResponseSchema,
  questV2CandidateApplicationParamsSchema,
  questV2CandidateApplicationResponseSchema,
  questV2CandidateSelectionParamsSchema,
  questV2CandidateSelectionResponseSchema,
} from './quest-candidate-v2.schema';
import { createQuestIdempotencyKeyGuard } from './quest-idempotency.guard';

export const questCandidateV2Route = new Elysia({
  name: 'quest-candidate-v2-route',
  prefix: API_V2_PREFIX,
})
  .use(createQuestIdempotencyKeyGuard('candidate-application-v2'))
  .use(authGuard)
  .post('/quests/:questId/applications', createQuestV2CandidateApplicationController, {
    params: questV2CandidateApplicationParamsSchema,
    headers: questV2CandidateApplicationHeadersSchema,
    response: responses(questV2CandidateApplicationResponseSchema, 400, 401, 404, 409, 503),
    detail: {
      tags: ['Quest Candidates v2'],
      summary: 'Apply to an open v2 Candidate Quest',
      description: 'Creates one Candidate application for an eligible Prospective Worker on a SINGLE Candidate Quest.',
      operationId: 'createQuestApplicationV2',
      security: betterAuthSecurity,
    },
  })
  .get('/quests/:questId/applications', listQuestV2CandidateApplicationsController, {
    params: questV2CandidateApplicationParamsSchema,
    response: responses(questV2CandidateApplicationListResponseSchema, 401, 404, 500),
    detail: {
      tags: ['Quest Candidates v2'],
      summary: 'List permitted v2 Candidate applications',
      description: 'The owning Hirer can list all applications. A Candidate can read only that Candidate\'s application.',
      operationId: 'listQuestApplicationsV2',
      security: betterAuthSecurity,
    },
  })
  .get('/quests/:questId/applications/:applicationId', getQuestV2CandidateApplicationController, {
    params: questV2CandidateApplicationDetailParamsSchema,
    response: responses(questV2CandidateApplicationResponseSchema, 401, 404, 500),
    detail: {
      tags: ['Quest Candidates v2'],
      summary: 'Read a permitted v2 Candidate application',
      description: 'A Candidate can read that Candidate\'s application and the owning Hirer can read any application for the Quest.',
      operationId: 'getQuestApplicationV2',
      security: betterAuthSecurity,
    },
  })
  .post('/quests/:questId/applications/:applicationId/withdraw', withdrawQuestV2CandidateApplicationController, {
    params: questV2CandidateApplicationDetailParamsSchema,
    headers: questV2CandidateApplicationHeadersSchema,
    response: responses(questV2CandidateApplicationResponseSchema, 400, 401, 404, 409, 503),
    detail: {
      tags: ['Quest Candidates v2'],
      summary: 'Withdraw a v2 Candidate application',
      description: 'A Candidate can withdraw that Candidate\'s application only while the Quest is QUEST_OPEN and before selection.',
      operationId: 'withdrawQuestApplicationV2',
      security: betterAuthSecurity,
    },
  })
  .post('/quests/:questId/applications/:applicationId/select', selectQuestV2CandidateApplicationController, {
    params: questV2CandidateSelectionParamsSchema,
    headers: questV2CandidateApplicationHeadersSchema,
    response: responses(questV2CandidateSelectionResponseSchema, 400, 401, 404, 409, 503),
    detail: {
      tags: ['Quest Candidates v2'],
      summary: 'Select a v2 Candidate application',
      description: 'The owning Hirer selects one applied Candidate. The Server creates the Assignment and rejects every other application atomically.',
      operationId: 'selectQuestApplicationV2',
      security: betterAuthSecurity,
    },
  });
