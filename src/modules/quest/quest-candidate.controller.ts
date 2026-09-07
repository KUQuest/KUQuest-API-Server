import type { AuthedContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { Static } from 'elysia';

import {
  acceptInvitation,
  createApplication,
  createInvitation,
  createTeam,
  declineInvitation,
  getApplication,
  getOwnInvitation,
  getTeam,
  listApplications,
  listOwnInvitations,
  listTeamInvitations,
  leaveTeam,
  listTeamMembers,
  listTeams,
  removeTeamMember,
  revokeInvitation,
  submitTeam,
  selectCandidate,
  updateApplication,
  updateTeam,
  withdrawApplication,
} from './quest-candidate.service';
import type {
  applicationCreateSchema,
  applicationDetailParamsSchema,
  applicationParamsSchema,
  applicationUpdateSchema,
  candidateSelectionApplicationParamsSchema,
  candidateSelectionTeamParamsSchema,
  invitationCreateSchema,
  invitationDetailParamsSchema,
  invitationParamsSchema,
  ownInvitationParamsSchema,
  teamCreateSchema,
  teamDetailParamsSchema,
  teamMemberParamsSchema,
  teamParamsSchema,
  teamUpdateSchema,
} from './quest-candidate.schema';
import { WorkChatTransitionError } from './quest-assignment.service';

type Set = AuthedContext['set'];
const notFound = (set: Set, code: 'QUEST_NOT_FOUND' | 'APPLICATION_NOT_FOUND' | 'TEAM_NOT_FOUND' | 'INVITATION_NOT_FOUND' = 'APPLICATION_NOT_FOUND', message = 'Candidate resource not found') => { set.status = 404; return apiError(code, message); };
const conflict = (set: Set, code: string, message: string) => { set.status = 409; return apiError(code, message); };
const serializeApplication = (row: { appliedAt: Date; [key: string]: unknown }) => ({ ...row, appliedAt: row.appliedAt.toISOString() });
const serializeMember = (row: { joinedAt: Date; userId: string }) => ({ ...row, joinedAt: row.joinedAt.toISOString() });
const serializeTeam = (row: { createdAt: Date; members: { joinedAt: Date; userId: string }[]; [key: string]: unknown }) => ({ ...row, createdAt: row.createdAt.toISOString(), members: row.members.map(serializeMember) });
const serializeInvitation = (row: { createdAt: Date; respondedAt: Date | null; expiresAt: Date; [key: string]: unknown }) => ({ ...row, createdAt: row.createdAt.toISOString(), respondedAt: row.respondedAt?.toISOString() ?? null, expiresAt: row.expiresAt.toISOString() });

export const selectCandidateController = async ({ params, request, session, set }: AuthedContext & { params: Static<typeof candidateSelectionApplicationParamsSchema | typeof candidateSelectionTeamParamsSchema> }) => {
  const commandId = request?.headers.get('idempotency-key');
  if (!commandId?.trim()) {
    set.status = 400;
    return apiError('IDEMPOTENCY_KEY_REQUIRED', 'The Idempotency-Key header is required');
  }
  const target = 'applicationId' in params ? { type: 'APPLICATION' as const, id: params.applicationId } : { type: 'TEAM' as const, id: params.teamId };
  try {
    const result = await selectCandidate(session.user.id, params.questId, target, { commandId });
    if ('assignments' in result) return apiSuccess({ ...result, assignments: result.assignments.map((assignment) => ({ ...assignment, startedAt: assignment.startedAt?.toISOString() ?? null, createdAt: assignment.createdAt.toISOString() })) });
    if (result.outcome === 'idempotency-key-required') { set.status = 400; return apiError('IDEMPOTENCY_KEY_REQUIRED', 'The Idempotency-Key header is required'); }
    if (result.outcome === 'not-found') return notFound(set, 'QUEST_NOT_FOUND', 'Quest not found');
    if (result.outcome === 'application-not-found') return notFound(set, 'APPLICATION_NOT_FOUND', 'Application not found');
    if (result.outcome === 'team-not-found') return notFound(set, 'TEAM_NOT_FOUND', 'Team not found');
    if (result.outcome === 'not-open') return conflict(set, 'QUEST_NOT_OPEN', 'Only an open Quest can accept a Candidate selection');
    if (result.outcome === 'not-allowed') return conflict(set, 'CANDIDATE_SELECTION_NOT_ALLOWED', 'Candidate selection is not allowed for this Quest or Hirer');
    if (result.outcome === 'not-selectable') return conflict(set, 'CANDIDATE_NOT_SELECTABLE', 'The Candidate is not submitted or is no longer eligible');
    if (result.outcome === 'headcount-mismatch') return conflict(set, 'TEAM_HEADCOUNT_MISMATCH', 'Team size must equal Quest headcount');
    if (result.outcome === 'already-assigned') return conflict(set, 'ASSIGNMENT_ALREADY_EXISTS', 'A selected Worker is already assigned to this Quest');
    if (result.outcome === 'idempotency-key-reused') return conflict(set, 'IDEMPOTENCY_KEY_REUSED', 'The Idempotency-Key was used for a different request');
    set.status = 503;
    return apiError('IDEMPOTENCY_UNAVAILABLE', 'The Idempotency-Key result is unavailable');
  } catch (error) {
    if (error instanceof WorkChatTransitionError) { set.status = 503; return apiError('WORK_CHAT_UNAVAILABLE', 'Work Chat membership could not be updated'); }
    throw error;
  }
};

export const createApplicationController = async ({ body, params, session, set }: AuthedContext & { body: Static<typeof applicationCreateSchema>; params: Static<typeof applicationParamsSchema> }) => {
  const result = await createApplication(session.user.id, params.questId, body);
  if ('outcome' in result) return result.outcome === 'already-exists' ? conflict(set, 'APPLICATION_ALREADY_EXISTS', 'You already have an application for this Quest') : notFound(set, 'QUEST_NOT_FOUND', 'Quest not found');
  return apiSuccess(serializeApplication(result));
};
export const listApplicationsController = async ({ params, session, set }: AuthedContext & { params: Static<typeof applicationParamsSchema> }) => {
  const result = await listApplications(session.user.id, params.questId);
  if ('outcome' in result) return notFound(set, 'QUEST_NOT_FOUND', 'Quest not found');
  return apiSuccess({ items: result.map(serializeApplication) });
};
export const getApplicationController = async ({ params, session, set }: AuthedContext & { params: Static<typeof applicationDetailParamsSchema> }) => {
  const result = await getApplication(session.user.id, params.questId, params.applicationId);
  return result ? apiSuccess(serializeApplication(result)) : notFound(set, 'APPLICATION_NOT_FOUND', 'Application not found');
};
export const updateApplicationController = async ({ body, params, session, set }: AuthedContext & { body: Static<typeof applicationUpdateSchema>; params: Static<typeof applicationDetailParamsSchema> }) => {
  const result = await updateApplication(session.user.id, params.questId, params.applicationId, body);
  if ('outcome' in result) return result.outcome === 'not-editable' ? conflict(set, 'APPLICATION_NOT_EDITABLE', 'Only an applied application can be edited') : notFound(set, 'APPLICATION_NOT_FOUND', 'Application not found');
  return apiSuccess(serializeApplication(result));
};
export const withdrawApplicationController = async ({ params, session, set }: AuthedContext & { params: Static<typeof applicationDetailParamsSchema> }) => {
  const result = await withdrawApplication(session.user.id, params.questId, params.applicationId);
  if ('outcome' in result) return result.outcome === 'not-withdrawable' ? conflict(set, 'APPLICATION_NOT_WITHDRAWABLE', 'This application cannot be withdrawn') : notFound(set, 'APPLICATION_NOT_FOUND', 'Application not found');
  return apiSuccess(serializeApplication(result));
};

export const createTeamController = async ({ body, params, session, set }: AuthedContext & { body: Static<typeof teamCreateSchema>; params: Static<typeof teamParamsSchema> }) => {
  const result = await createTeam(session.user.id, params.questId, body);
  if ('outcome' in result) return result.outcome === 'already-exists' ? conflict(set, 'TEAM_ALREADY_EXISTS', 'You already belong to a Team for this Quest') : notFound(set, 'QUEST_NOT_FOUND', 'Quest not found');
  return apiSuccess(serializeTeam(result));
};
export const listTeamsController = async ({ params, session, set }: AuthedContext & { params: Static<typeof teamParamsSchema> }) => {
  const result = await listTeams(session.user.id, params.questId);
  if ('outcome' in result) return notFound(set, 'QUEST_NOT_FOUND', 'Quest not found');
  return apiSuccess({ items: result.map(serializeTeam) });
};
export const getTeamController = async ({ params, session, set }: AuthedContext & { params: Static<typeof teamDetailParamsSchema> }) => { const result = await getTeam(session.user.id, params.questId, params.teamId); return result ? apiSuccess(serializeTeam(result)) : notFound(set, 'TEAM_NOT_FOUND', 'Team not found'); };
export const updateTeamController = async ({ body, params, session, set }: AuthedContext & { body: Static<typeof teamUpdateSchema>; params: Static<typeof teamDetailParamsSchema> }) => {
  const result = await updateTeam(session.user.id, params.questId, params.teamId, body);
  if ('outcome' in result) return result.outcome === 'not-authorized' ? notFound(set, 'TEAM_NOT_FOUND', 'Team not found') : conflict(set, 'TEAM_NOT_EDITABLE', 'Only a forming Team Leader can edit the Team');
  return apiSuccess(serializeTeam(result));
};
export const listTeamMembersController = async ({ params, session, set }: AuthedContext & { params: Static<typeof teamDetailParamsSchema> }) => { const result = await listTeamMembers(session.user.id, params.questId, params.teamId); return result ? apiSuccess({ items: (await result).map(serializeMember) }) : notFound(set, 'TEAM_NOT_FOUND', 'Team not found'); };
export const submitTeamController = async ({ params, session, set }: AuthedContext & { params: Static<typeof teamDetailParamsSchema> }) => {
  const result = await submitTeam(session.user.id, params.questId, params.teamId);
  if ('outcome' in result) return result.outcome === 'headcount-mismatch' ? conflict(set, 'TEAM_HEADCOUNT_MISMATCH', 'Team size must equal Quest headcount') : result.outcome === 'not-authorized' ? notFound(set, 'TEAM_NOT_FOUND', 'Team not found') : conflict(set, 'TEAM_NOT_SUBMITTABLE', 'This Team cannot be submitted');
  return apiSuccess(serializeTeam(result));
};
export const leaveTeamController = async ({ params, session, set }: AuthedContext & { params: Static<typeof teamDetailParamsSchema> }) => {
  const result = await leaveTeam(session.user.id, params.questId, params.teamId);
  if ('outcome' in result) return result.outcome === 'not-found' ? notFound(set, 'TEAM_NOT_FOUND', 'Team not found') : conflict(set, 'TEAM_NOT_MUTABLE', 'Only forming Team membership can change');
  return apiSuccess(serializeTeam(result));
};
export const removeTeamMemberController = async ({ params, session, set }: AuthedContext & { params: Static<typeof teamMemberParamsSchema> }) => {
  const result = await removeTeamMember(session.user.id, params.questId, params.teamId, params.memberId);
  if ('outcome' in result) {
    if (result.outcome === 'not-found' || result.outcome === 'not-authorized') return notFound(set, 'TEAM_NOT_FOUND', 'Team not found');
    if (result.outcome === 'leader-removal-not-allowed') return conflict(set, 'TEAM_LEADER_REMOVAL_NOT_ALLOWED', 'A Team Leader must leave the Team instead');
    return conflict(set, 'TEAM_NOT_MUTABLE', 'Only forming Team membership can change');
  }
  return apiSuccess(serializeTeam(result));
};

export const createInvitationController = async ({ body, params, session, set }: AuthedContext & { body: Static<typeof invitationCreateSchema>; params: Static<typeof invitationParamsSchema> }) => {
  const result = await createInvitation(session.user.id, params.questId, params.teamId, body);
  if ('outcome' in result) {
    if (result.outcome === 'already-pending') return conflict(set, 'INVITATION_ALREADY_PENDING', 'A pending invitation already exists');
    if (result.outcome === 'already-member') return conflict(set, 'WORKER_ALREADY_IN_TEAM', 'The Worker already belongs to a Team for this Quest');
    return result.outcome === 'not-eligible' ? conflict(set, 'INVITATION_NOT_ALLOWED', 'Only a forming Team Leader can invite a Worker') : notFound(set, 'INVITATION_NOT_FOUND', 'Team or Quest not found');
  }
  return apiSuccess(serializeInvitation(result));
};
export const listTeamInvitationsController = async ({ params, session, set }: AuthedContext & { params: Static<typeof invitationParamsSchema> }) => { const result = await listTeamInvitations(session.user.id, params.questId, params.teamId); return result ? apiSuccess({ items: result.map(serializeInvitation) }) : notFound(set, 'INVITATION_NOT_FOUND', 'Team not found'); };
export const listOwnInvitationsController = async ({ session }: AuthedContext) => apiSuccess({ items: (await listOwnInvitations(session.user.id)).map(serializeInvitation) });
export const getOwnInvitationController = async ({ params, session, set }: AuthedContext & { params: Static<typeof ownInvitationParamsSchema> }) => { const result = await getOwnInvitation(session.user.id, params.invitationId); return result ? apiSuccess(serializeInvitation(result)) : notFound(set, 'INVITATION_NOT_FOUND', 'Invitation not found'); };
export const revokeInvitationController = async ({ params, session, set }: AuthedContext & { params: Static<typeof invitationDetailParamsSchema> }) => {
  const result = await revokeInvitation(session.user.id, params.questId, params.teamId, params.invitationId);
  if ('outcome' in result) return result.outcome === 'not-actionable' ? conflict(set, 'INVITATION_NOT_PENDING', 'Only a pending invitation can be revoked') : notFound(set, 'INVITATION_NOT_FOUND', 'Invitation not found');
  return apiSuccess(serializeInvitation(result));
};
const respond = (accepted: boolean) => async ({ params, session, set }: AuthedContext & { params: Static<typeof ownInvitationParamsSchema> }) => {
  const result = accepted ? await acceptInvitation(session.user.id, params.invitationId) : await declineInvitation(session.user.id, params.invitationId);
  if ('outcome' in result) {
    if (result.outcome === 'expired') return conflict(set, 'INVITATION_EXPIRED', 'The invitation has expired');
    if (result.outcome === 'not-actionable') return conflict(set, 'INVITATION_NOT_PENDING', 'The invitation is no longer pending');
    if (result.outcome === 'not-eligible') return conflict(set, 'INVITATION_NOT_ALLOWED', 'The Team is no longer forming');
    if (result.outcome === 'already-member') return conflict(set, 'WORKER_ALREADY_IN_TEAM', 'The Worker already belongs to a Team for this Quest');
    return notFound(set, 'INVITATION_NOT_FOUND', 'Invitation not found');
  }
  return apiSuccess(serializeInvitation(result));
};
export const acceptInvitationController = respond(true);
export const declineInvitationController = respond(false);

