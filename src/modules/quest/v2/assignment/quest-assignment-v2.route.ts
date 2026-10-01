import { authGuard, memberBanGuard } from '@/modules/auth';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { API_V2_PREFIX } from '@/shared/api-version';

import { Elysia } from 'elysia';

import {
  joinQuestV2Controller,
  listMyQuestV2AssignmentsController,
  listQuestV2AssignmentsController,
  startQuestWorkV2Controller,
} from './quest-assignment-v2.controller';
import {
  decideQuestUnderfilledV2Controller,
  getQuestUnderfilledV2Controller,
  respondToQuestUnderfilledV2Controller,
} from '../lifecycle';
import {
  questV2AssignmentHeadersSchema,
  questV2AssignmentListResponseSchema,
  questV2AssignmentMineQuerySchema,
  questV2AssignmentParamsSchema,
  questV2MyAssignmentListResponseSchema,
  questV2AssignmentResponseSchema,
  questV2StartWorkResponseSchema,
} from './quest-assignment-v2.schema';
import {
  questV2UnderfilledConsentInputSchema,
  questV2UnderfilledDecisionInputSchema,
  questV2UnderfilledHeadersSchema,
  questV2UnderfilledParamsSchema,
  questV2UnderfilledResponseSchema,
} from '../lifecycle';

export const questAssignmentV2Route = new Elysia({
  name: 'quest-assignment-v2-route',
  prefix: API_V2_PREFIX,
})
  .use(authGuard)
  .use(memberBanGuard)
  .get('/assignments/mine', listMyQuestV2AssignmentsController, {
    query: questV2AssignmentMineQuerySchema,
    response: responses(questV2MyAssignmentListResponseSchema, 400, 401, 500),
    detail: {
      tags: ['Quest Assignments v2'],
      summary: "List the authenticated Worker's v2 Assignments",
      description:
        "Returns the authenticated Worker's v2 Assignments, filtered by active, completed, or all status. Each item carries a compact `underfilled` summary (state, decision and consent expiry, headcount, cancellation reason) or null when the Quest has no underfilled process. The summary matches GET /quests/{questId}/underfilled at read time, so clients need no per-Assignment fetch.",
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
      description:
        "The owning Hirer can read all Assignments, including completed, incomplete, and cancelled Assignments, for Reviews. A Worker can read only that Worker's active Assignment.",
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
      description:
        'Creates an active Assignment for an eligible Worker. A GROUP Quest remains open until its published headcount is full. The capacity check and the Assignment insert run in one locked transaction, so server order decides who gets the last slot, and a replay with the same Idempotency-Key returns the original result. A 409 error code is one of: QUEST_FULL (no free slot), QUEST_NOT_OPEN (the Quest is not QUEST_OPEN), ALREADY_JOINED (the Worker already has an Assignment), QUEST_ROSTER_FROZEN, QUEST_MODE_NOT_ALLOWED, QUEST_PARTICIPATION_NOT_ALLOWED, HIRER_CANNOT_JOIN, MEMBER_RED_FLAGGED.',
      operationId: 'joinQuestV2',
      security: betterAuthSecurity,
    },
  })
  .post('/quests/:questId/start-work', startQuestWorkV2Controller, {
    params: questV2AssignmentParamsSchema,
    headers: questV2AssignmentHeadersSchema,
    response: responses(questV2StartWorkResponseSchema, 400, 401, 404, 409, 500),
    detail: {
      tags: ['Quest Assignments v2'],
      summary: 'Start Work on an assigned v2 Quest',
      description:
        'Records the required Worker Start Work action between startTime and dueAt. GROUP + FCFS requires every Active Worker; GROUP + CANDIDATE requires the Team Leader.',
      operationId: 'startQuestWorkV2',
      security: betterAuthSecurity,
    },
  })
  .get('/quests/:questId/underfilled', getQuestUnderfilledV2Controller, {
    params: questV2UnderfilledParamsSchema,
    response: responses(questV2UnderfilledResponseSchema, 400, 401, 404, 409, 500, 503),
    detail: {
      tags: ['Quests v2'],
      summary: 'Get an underfilled GROUP + FCFS Quest process',
      description:
        'Returns the Hirer decision or Active Worker consent window for an underfilled Quest.',
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
      description:
        'The owning Hirer chooses PROCEED or CANCEL during the ten-minute decision window.',
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
      description:
        'An Active Worker accepts or declines the revised Quest Reward during the ten-minute consent window.',
      operationId: 'respondToQuestUnderfilledV2',
      security: betterAuthSecurity,
    },
  });
