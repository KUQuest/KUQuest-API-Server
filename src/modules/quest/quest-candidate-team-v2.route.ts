import { authGuard } from '@/modules/auth';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { API_V2_PREFIX } from '@/shared/api-version';

import { Elysia } from 'elysia';

import {
  createQuestV2CandidateTeamController,
  getQuestV2CandidateTeamController,
  joinQuestV2CandidateTeamController,
  leaveQuestV2CandidateTeamController,
  listQuestV2CandidateTeamsController,
  regenerateQuestV2CandidateTeamJoinCodeController,
  removeQuestV2CandidateTeamMemberController,
  selectQuestV2CandidateTeamController,
  submitQuestV2CandidateTeamController,
} from './quest-candidate-team-v2.controller';
import {
  questV2CandidateTeamCreateSchema,
  questV2CandidateTeamDetailParamsSchema,
  questV2CandidateTeamHeadersSchema,
  questV2CandidateTeamJoinSchema,
  questV2CandidateTeamListResponseSchema,
  questV2CandidateTeamMemberParamsSchema,
  questV2CandidateTeamParamsSchema,
  questV2CandidateTeamResponseSchema,
  questV2CandidateTeamSubmissionSchema,
} from './quest-candidate-team-v2.schema';
import { questV2CandidateSelectionResponseSchema } from './quest-candidate-v2.schema';
import { createQuestIdempotencyKeyGuard } from './quest-idempotency.guard';

export const questCandidateTeamV2Route = new Elysia({
  name: 'quest-candidate-team-v2-route',
  prefix: API_V2_PREFIX,
})
  .use(createQuestIdempotencyKeyGuard('candidate-team-v2'))
  .use(authGuard)
  .post('/quests/:questId/teams', createQuestV2CandidateTeamController, {
    params: questV2CandidateTeamParamsSchema,
    body: questV2CandidateTeamCreateSchema,
    headers: questV2CandidateTeamHeadersSchema,
    response: responses(questV2CandidateTeamResponseSchema, 400, 401, 404, 409, 503, { successStatus: 201 }),
    detail: {
      tags: ['Quest Candidate Teams v2'],
      summary: 'Create a Candidate Team for an open v2 Quest',
      description: 'An eligible Prospective Worker creates one forming Candidate Team and receives its 24-hour Join Code.',
      operationId: 'createQuestCandidateTeamV2',
      security: betterAuthSecurity,
    },
  })
  .get('/quests/:questId/teams', listQuestV2CandidateTeamsController, {
    params: questV2CandidateTeamParamsSchema,
    response: responses(questV2CandidateTeamListResponseSchema, 401, 404, 500),
    detail: {
      tags: ['Quest Candidate Teams v2'],
      summary: 'List permitted Candidate Teams for a v2 Quest',
      description: 'The Hirer can list all Candidate Teams. A Team Member can list that Member\'s Candidate Team.',
      operationId: 'listQuestCandidateTeamsV2',
      security: betterAuthSecurity,
    },
  })
  .get('/quests/:questId/teams/:teamId', getQuestV2CandidateTeamController, {
    params: questV2CandidateTeamDetailParamsSchema,
    response: responses(questV2CandidateTeamResponseSchema, 401, 404, 500),
    detail: {
      tags: ['Quest Candidate Teams v2'],
      summary: 'Read a permitted Candidate Team',
      description: 'The Hirer and Candidate Team Members can read a forming or submitted Candidate Team. Join Code plaintext is not returned by reads.',
      operationId: 'getQuestCandidateTeamV2',
      security: betterAuthSecurity,
    },
  })
  .post('/quests/:questId/teams/:teamId/join', joinQuestV2CandidateTeamController, {
    params: questV2CandidateTeamDetailParamsSchema,
    body: questV2CandidateTeamJoinSchema,
    headers: questV2CandidateTeamHeadersSchema,
    response: responses(questV2CandidateTeamResponseSchema, 400, 401, 404, 409, 503),
    detail: {
      tags: ['Quest Candidate Teams v2'],
      summary: 'Join a forming Candidate Team with a Join Code',
      description: 'An eligible Prospective Worker joins the Candidate Team only with its current, unexpired Join Code.',
      operationId: 'joinQuestCandidateTeamV2',
      security: betterAuthSecurity,
    },
  })
  .post('/quests/:questId/teams/:teamId/leave', leaveQuestV2CandidateTeamController, {
    params: questV2CandidateTeamDetailParamsSchema,
    headers: questV2CandidateTeamHeadersSchema,
    response: responses(questV2CandidateTeamResponseSchema, 400, 401, 404, 409, 503),
    detail: {
      tags: ['Quest Candidate Teams v2'],
      summary: 'Leave a forming Candidate Team',
      description: 'A forming Member can leave. If the Team Leader leaves, leadership transfers to the earliest joined remaining Member.',
      operationId: 'leaveQuestCandidateTeamV2',
      security: betterAuthSecurity,
    },
  })
  .delete('/quests/:questId/teams/:teamId/members/:memberId', removeQuestV2CandidateTeamMemberController, {
    params: questV2CandidateTeamMemberParamsSchema,
    headers: questV2CandidateTeamHeadersSchema,
    response: responses(questV2CandidateTeamResponseSchema, 400, 401, 404, 409, 503),
    detail: {
      tags: ['Quest Candidate Teams v2'],
      summary: 'Remove a Member from a forming Candidate Team',
      description: 'Only the Team Leader can remove another forming Member.',
      operationId: 'removeQuestCandidateTeamMemberV2',
      security: betterAuthSecurity,
    },
  })
  .post('/quests/:questId/teams/:teamId/join-code', regenerateQuestV2CandidateTeamJoinCodeController, {
    params: questV2CandidateTeamDetailParamsSchema,
    headers: questV2CandidateTeamHeadersSchema,
    response: responses(questV2CandidateTeamResponseSchema, 400, 401, 404, 409, 503),
    detail: {
      tags: ['Quest Candidate Teams v2'],
      summary: 'Regenerate a Candidate Team Join Code',
      description: 'Only the Team Leader can regenerate the code while the Candidate Team is forming. The previous code becomes invalid.',
      operationId: 'regenerateQuestCandidateTeamJoinCodeV2',
      security: betterAuthSecurity,
    },
  })
  .post('/quests/:questId/teams/:teamId/submit', submitQuestV2CandidateTeamController, {
    params: questV2CandidateTeamDetailParamsSchema,
    body: questV2CandidateTeamSubmissionSchema,
    headers: questV2CandidateTeamHeadersSchema,
    response: responses(questV2CandidateTeamResponseSchema, 400, 401, 404, 409, 503),
    detail: {
      tags: ['Quest Candidate Teams v2'],
      summary: 'Submit a full Candidate Team',
      description: 'The Team Leader submits a full, immutable Candidate Team with text and at least one valid Work Conversation Attachment file.',
      operationId: 'submitQuestCandidateTeamV2',
      security: betterAuthSecurity,
    },
  })
  .post('/quests/:questId/teams/:teamId/select', selectQuestV2CandidateTeamController, {
    params: questV2CandidateTeamDetailParamsSchema,
    headers: questV2CandidateTeamHeadersSchema,
    response: responses(questV2CandidateSelectionResponseSchema, 400, 401, 404, 409, 503),
    detail: {
      tags: ['Quest Candidate Teams v2'],
      summary: 'Select a submitted Candidate Team',
      description: 'The owning Hirer selects one submitted Candidate Team. The Server creates one Assignment per Member and rejects other Candidate applications and submitted Teams atomically.',
      operationId: 'selectQuestCandidateTeamV2',
      security: betterAuthSecurity,
    },
  });
