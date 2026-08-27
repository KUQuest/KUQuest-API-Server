import { authGuard } from '@/modules/auth';
import { API_V1_PREFIX } from '@/shared/api-version';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';

import { Elysia } from 'elysia';

import { joinNoCandidateQuestController } from './quest-assignment.controller';
import { createQuestIdempotencyKeyGuard } from './quest-idempotency.guard';
import {
  questAssignmentHeadersSchema,
  questAssignmentParamsSchema,
  questAssignmentResponseSchema,
} from './quest-assignment.schema';

/** Authenticated Worker commands for Assignment creation. */
export const questAssignmentRoute = new Elysia({
  name: 'quest-assignment-route',
  prefix: `${API_V1_PREFIX}/quests`,
})
  .use(createQuestIdempotencyKeyGuard('quest-join'))
  .use(authGuard)
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
  });
