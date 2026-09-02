import { authGuard } from '@/modules/auth';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { API_V2_PREFIX } from '@/shared/api-version';

import { Elysia } from 'elysia';

import {
  joinQuestV2Controller,
  listMyQuestV2AssignmentsController,
  listQuestV2AssignmentsController,
} from './quest-assignment-v2.controller';
import {
  decideQuestUnderfilledV2Controller,
  getQuestUnderfilledV2Controller,
  respondToQuestUnderfilledV2Controller,
} from './quest-underfilled-v2.controller';
import {
  questV2AssignmentHeadersSchema,
  questV2AssignmentListResponseSchema,
  questV2AssignmentParamsSchema,
  questV2AssignmentResponseSchema,
} from './quest-assignment-v2.schema';
import {
  questV2UnderfilledConsentInputSchema,
  questV2UnderfilledDecisionInputSchema,
  questV2UnderfilledHeadersSchema,
  questV2UnderfilledParamsSchema,
  questV2UnderfilledResponseSchema,
} from './quest-underfilled-v2.schema';

export const questAssignmentV2Route = new Elysia({
  name: 'quest-assignment-v2-route',
  prefix: API_V2_PREFIX,
})
  .use(authGuard)
  .get('/assignments/mine', listMyQuestV2AssignmentsController, {
    response: responses(questV2AssignmentListResponseSchema, 401, 500),
    detail: {
      tags: ['Quest Assignments v2'],
      summary: 'List the authenticated Worker\'s v2 Assignments',
      description: 'Returns the authenticated Worker\'s active Assignments from v2 Quests.',
      operationId: 'listMyQuestAssignmentsV2',
      security: betterAuthSecurity,
    },
  })
  .get('/quests/:questId/assignments', listQuestV2AssignmentsController, {
    params: questV2AssignmentParamsSchema,
    response: responses(questV2AssignmentListResponseSchema, 400, 401, 404, 500),
    detail: {
      tags: ['Quest Assignments v2'],
      summary: 'List permitted v2 Quest Assignments',
      description: 'The owning Hirer can read all active Assignments. An active Worker can read only that Worker\'s Assignment.',
      operationId: 'listQuestAssignmentsV2',
      security: betterAuthSecurity,
    },
  })
  .post('/quests/:questId/join', joinQuestV2Controller, {
    params: questV2AssignmentParamsSchema,
    headers: questV2AssignmentHeadersSchema,
    response: responses(questV2AssignmentResponseSchema, 400, 401, 404, 409, 503),
    detail: {
      tags: ['Quest Assignments v2'],
      summary: 'Join an open v2 FCFS Quest',
      description: 'Creates an active Assignment for an eligible Worker. A GROUP Quest remains open until its published headcount is full.',
      operationId: 'joinQuestV2',
      security: betterAuthSecurity,
    },
  })
  .get('/quests/:questId/underfilled', getQuestUnderfilledV2Controller, {
    params: questV2UnderfilledParamsSchema,
    response: responses(questV2UnderfilledResponseSchema, 400, 401, 404, 409, 500, 503),
    detail: {
      tags: ['Quests v2'],
      summary: 'Get an underfilled GROUP + FCFS Quest process',
      description: 'Returns the Hirer decision or Active Worker consent window for an underfilled Quest.',
      operationId: 'getQuestUnderfilledV2',
      security: betterAuthSecurity,
    },
  })
  .post('/quests/:questId/underfilled/decision', decideQuestUnderfilledV2Controller, {
    params: questV2UnderfilledParamsSchema,
    body: questV2UnderfilledDecisionInputSchema,
    headers: questV2UnderfilledHeadersSchema,
    response: responses(questV2UnderfilledResponseSchema, 400, 401, 404, 409, 500, 503),
    detail: {
      tags: ['Quests v2'],
      summary: 'Choose an underfilled Quest decision',
      description: 'The owning Hirer chooses PROCEED or CANCEL during the ten-minute decision window.',
      operationId: 'decideQuestUnderfilledV2',
      security: betterAuthSecurity,
    },
  })
  .post('/quests/:questId/underfilled/consent', respondToQuestUnderfilledV2Controller, {
    params: questV2UnderfilledParamsSchema,
    body: questV2UnderfilledConsentInputSchema,
    headers: questV2UnderfilledHeadersSchema,
    response: responses(questV2UnderfilledResponseSchema, 400, 401, 404, 409, 500, 503),
    detail: {
      tags: ['Quests v2'],
      summary: 'Respond to an underfilled Quest consent request',
      description: 'An Active Worker accepts or declines the revised Quest Reward during the ten-minute consent window.',
      operationId: 'respondToQuestUnderfilledV2',
      security: betterAuthSecurity,
    },
  });
