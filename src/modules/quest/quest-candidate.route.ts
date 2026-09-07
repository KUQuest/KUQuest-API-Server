import { authGuard } from '@/modules/auth';
import { API_V1_PREFIX } from '@/shared/api-version';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { rejectUnknownFields } from '@/shared/reject-unknown-fields';

import { Elysia } from 'elysia';

import {
  acceptInvitationController,
  createApplicationController,
  createInvitationController,
  createTeamController,
  declineInvitationController,
  getApplicationController,
  getOwnInvitationController,
  getTeamController,
  leaveTeamController,
  listApplicationsController,
  listOwnInvitationsController,
  listTeamInvitationsController,
  listTeamMembersController,
  listTeamsController,
  removeTeamMemberController,
  revokeInvitationController,
  selectCandidateController,
  submitTeamController,
  updateApplicationController,
  updateTeamController,
  withdrawApplicationController,
} from './quest-candidate.controller';
import {
  applicationCreateSchema,
  applicationDetailParamsSchema,
  applicationListResponseSchema,
  applicationParamsSchema,
  applicationResponseSchema,
  applicationUpdateSchema,
  candidateSelectionApplicationParamsSchema,
  candidateSelectionHeadersSchema,
  candidateSelectionResponseSchema,
  candidateSelectionTeamParamsSchema,
  invitationCreateSchema,
  invitationDetailParamsSchema,
  invitationListResponseSchema,
  invitationParamsSchema,
  invitationResponseSchema,
  ownInvitationParamsSchema,
  teamCreateSchema,
  teamDetailParamsSchema,
  teamListResponseSchema,
  teamMemberParamsSchema,
  teamMembersResponseSchema,
  teamParamsSchema,
  teamResponseSchema,
  teamUpdateSchema,
} from './quest-candidate.schema';
import { createQuestIdempotencyKeyGuard } from './quest-idempotency.guard';

export const questCandidateRoute = new Elysia({ name: 'quest-candidate-route', prefix: `${API_V1_PREFIX}/quests` })
  .use(createQuestIdempotencyKeyGuard('candidate-selection'))
  .use(authGuard)
  .post('/:questId/applications', createApplicationController, { params: applicationParamsSchema, body: applicationCreateSchema, transform: rejectUnknownFields(applicationCreateSchema), response: responses(applicationResponseSchema, 400, 401, 404, 409), detail: { tags: ['Quest Candidates'], summary: 'Apply to a Candidate Quest', operationId: 'createQuestApplication', security: betterAuthSecurity } })
  .get('/:questId/applications', listApplicationsController, { params: applicationParamsSchema, response: responses(applicationListResponseSchema, 401, 404), detail: { tags: ['Quest Candidates'], summary: 'List Quest applications', operationId: 'listQuestApplications', security: betterAuthSecurity } })
  .get('/:questId/applications/:applicationId', getApplicationController, { params: applicationDetailParamsSchema, response: responses(applicationResponseSchema, 401, 404), detail: { tags: ['Quest Candidates'], summary: 'Get a Quest application', operationId: 'getQuestApplication', security: betterAuthSecurity } })
  .patch('/:questId/applications/:applicationId', updateApplicationController, { params: applicationDetailParamsSchema, body: applicationUpdateSchema, transform: rejectUnknownFields(applicationUpdateSchema), response: responses(applicationResponseSchema, 400, 401, 404, 409), detail: { tags: ['Quest Candidates'], summary: 'Edit application rework limit', operationId: 'updateQuestApplication', security: betterAuthSecurity } })
  .post('/:questId/applications/:applicationId/withdraw', withdrawApplicationController, { params: applicationDetailParamsSchema, response: responses(applicationResponseSchema, 401, 404, 409), detail: { tags: ['Quest Candidates'], summary: 'Withdraw a Quest application', operationId: 'withdrawQuestApplication', security: betterAuthSecurity } })
  .post('/:questId/applications/:applicationId/select', selectCandidateController, { params: candidateSelectionApplicationParamsSchema, headers: candidateSelectionHeadersSchema, response: responses(candidateSelectionResponseSchema, 400, 401, 404, 409, 503), detail: { tags: ['Quest Candidates'], summary: 'Select a Candidate application', operationId: 'selectQuestApplication', security: betterAuthSecurity } })
  .post('/:questId/teams', createTeamController, { params: teamParamsSchema, body: teamCreateSchema, transform: rejectUnknownFields(teamCreateSchema), response: responses(teamResponseSchema, 400, 401, 404, 409), detail: { tags: ['Quest Teams'], summary: 'Create a Candidate Team', operationId: 'createQuestTeam', security: betterAuthSecurity } })
  .get('/:questId/teams', listTeamsController, { params: teamParamsSchema, response: responses(teamListResponseSchema, 401, 404), detail: { tags: ['Quest Teams'], summary: 'List Candidate Teams', operationId: 'listQuestTeams', security: betterAuthSecurity } })
  .get('/:questId/teams/:teamId', getTeamController, { params: teamDetailParamsSchema, response: responses(teamResponseSchema, 401, 404), detail: { tags: ['Quest Teams'], summary: 'Get a Candidate Team', operationId: 'getQuestTeam', security: betterAuthSecurity } })
  .patch('/:questId/teams/:teamId', updateTeamController, { params: teamDetailParamsSchema, body: teamUpdateSchema, transform: rejectUnknownFields(teamUpdateSchema), response: responses(teamResponseSchema, 400, 401, 404, 409), detail: { tags: ['Quest Teams'], summary: 'Edit forming Team metadata', operationId: 'updateQuestTeam', security: betterAuthSecurity } })
  .get('/:questId/teams/:teamId/members', listTeamMembersController, { params: teamDetailParamsSchema, response: responses(teamMembersResponseSchema, 401, 404), detail: { tags: ['Quest Teams'], summary: 'List Team members', operationId: 'listQuestTeamMembers', security: betterAuthSecurity } })
  .post('/:questId/teams/:teamId/leave', leaveTeamController, { params: teamDetailParamsSchema, response: responses(teamResponseSchema, 401, 404, 409), detail: { tags: ['Quest Teams'], summary: 'Leave a forming Candidate Team', operationId: 'leaveQuestTeam', security: betterAuthSecurity } })
  .delete('/:questId/teams/:teamId/members/:memberId', removeTeamMemberController, { params: teamMemberParamsSchema, response: responses(teamResponseSchema, 401, 404, 409), detail: { tags: ['Quest Teams'], summary: 'Remove a Member from a forming Candidate Team', operationId: 'removeQuestTeamMember', security: betterAuthSecurity } })
  .post('/:questId/teams/:teamId/submit', submitTeamController, { params: teamDetailParamsSchema, response: responses(teamResponseSchema, 401, 404, 409), detail: { tags: ['Quest Teams'], summary: 'Submit a full Candidate Team', operationId: 'submitQuestTeam', security: betterAuthSecurity } })
  .post('/:questId/teams/:teamId/select', selectCandidateController, { params: candidateSelectionTeamParamsSchema, headers: candidateSelectionHeadersSchema, response: responses(candidateSelectionResponseSchema, 400, 401, 404, 409, 503), detail: { tags: ['Quest Candidates'], summary: 'Select a Candidate Team', operationId: 'selectQuestTeam', security: betterAuthSecurity } })
  .post('/:questId/teams/:teamId/invitations', createInvitationController, { params: invitationParamsSchema, body: invitationCreateSchema, transform: rejectUnknownFields(invitationCreateSchema), response: responses(invitationResponseSchema, 400, 401, 404, 409), detail: { tags: ['Quest Invitations'], summary: 'Invite a Worker to a Team', operationId: 'createQuestTeamInvitation', security: betterAuthSecurity } })
  .get('/:questId/teams/:teamId/invitations', listTeamInvitationsController, { params: invitationParamsSchema, response: responses(invitationListResponseSchema, 401, 404), detail: { tags: ['Quest Invitations'], summary: 'List Team invitations', operationId: 'listQuestTeamInvitations', security: betterAuthSecurity } })
  .delete('/:questId/teams/:teamId/invitations/:invitationId', revokeInvitationController, { params: invitationDetailParamsSchema, response: responses(invitationResponseSchema, 401, 404, 409), detail: { tags: ['Quest Invitations'], summary: 'Revoke a pending Team invitation', operationId: 'revokeQuestTeamInvitation', security: betterAuthSecurity } })
  .get('/invitations', listOwnInvitationsController, { response: responses(invitationListResponseSchema, 401), detail: { tags: ['Quest Invitations'], summary: 'List own Team invitations', operationId: 'listOwnQuestInvitations', security: betterAuthSecurity } })
  .get('/invitations/:invitationId', getOwnInvitationController, { params: ownInvitationParamsSchema, response: responses(invitationResponseSchema, 401, 404), detail: { tags: ['Quest Invitations'], summary: 'Get own Team invitation', operationId: 'getOwnQuestInvitation', security: betterAuthSecurity } })
  .post('/invitations/:invitationId/accept', acceptInvitationController, { params: ownInvitationParamsSchema, response: responses(invitationResponseSchema, 401, 404, 409), detail: { tags: ['Quest Invitations'], summary: 'Accept a Team invitation', operationId: 'acceptQuestTeamInvitation', security: betterAuthSecurity } })
  .post('/invitations/:invitationId/decline', declineInvitationController, { params: ownInvitationParamsSchema, response: responses(invitationResponseSchema, 401, 404, 409), detail: { tags: ['Quest Invitations'], summary: 'Decline a Team invitation', operationId: 'declineQuestTeamInvitation', security: betterAuthSecurity } });
