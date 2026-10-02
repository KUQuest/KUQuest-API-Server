import { authGuard, memberBanGuard } from '@/modules/auth';
import { API_V1_PREFIX } from '@/shared/api-version';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';

import { Elysia } from 'elysia';

import {
  joinNoCandidateQuestController,
  startQuestWorkV1Controller,
} from '../controllers/quest-assignment.controller';
import {
  questAssignmentHeadersSchema,
  questAssignmentParamsSchema,
  questAssignmentResponseSchema,
  questStartWorkResponseSchema,
} from '../schemas/quest-assignment.schema';

/** Authenticated Worker commands for the Assignment lifecycle. */
export const questAssignmentRoute = new Elysia({
  name: 'quest-assignment-route',
  prefix: `${API_V1_PREFIX}/quests`,
})
  .use(authGuard)
  .use(memberBanGuard)
  .post('/:questId/join', joinNoCandidateQuestController, {
    params: questAssignmentParamsSchema,
    headers: questAssignmentHeadersSchema,
    response: responses(questAssignmentResponseSchema, 400, 401, 404, 409, 503),
    detail: {
      tags: ['Quest Assignments'],
      summary: 'Join a NO_CANDIDATE Quest directly',
      description:
        'Accepts the authenticated Member as a Worker on an open NO_CANDIDATE Quest. The request creates one active Assignment atomically; GROUP Quests stay open until their exact headcount is reached. A non-blank Idempotency-Key is required, persisted with the request fingerprint, and passed to the Work Chat transition boundary. Missing or blank keys return 400 IDEMPOTENCY_KEY_REQUIRED.',
      operationId: 'joinNoCandidateQuest',
      security: betterAuthSecurity,
    },
  })
  .post('/:questId/start-work', startQuestWorkV1Controller, {
    params: questAssignmentParamsSchema,
    headers: questAssignmentHeadersSchema,
    response: responses(questStartWorkResponseSchema, 400, 401, 404, 409, 500),
    detail: {
      tags: ['Quest Assignments'],
      summary: 'Start Work on an assigned legacy Quest',
      description:
        'Records the authenticated Worker Start Work action between startTime and dueAt. SOLO Quests require the assigned Worker; GROUP + NO_CANDIDATE requires every Active Worker; GROUP + CANDIDATE requires the selected Team Leader.',
      operationId: 'startQuestWorkV1',
      security: betterAuthSecurity,
    },
  });
