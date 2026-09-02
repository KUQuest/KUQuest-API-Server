import type { AuthedContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';

import type {
  QuestV2CandidateTeamDetailParams,
  QuestV2CandidateTeamMemberParams,
  QuestV2CandidateTeamParams,
  QuestV2CandidateTeamCreateInput,
  QuestV2CandidateTeamJoinInput,
  QuestV2CandidateTeamSubmissionInput,
} from './quest-candidate-team-v2.schema';
import {
  createQuestV2CandidateTeam,
  getQuestV2CandidateTeam,
  joinQuestV2CandidateTeam,
  leaveQuestV2CandidateTeam,
  listQuestV2CandidateTeams,
  regenerateQuestV2CandidateTeamJoinCode,
  removeQuestV2CandidateTeamMember,
  selectQuestV2CandidateTeam,
  submitQuestV2CandidateTeam,
  type QuestV2CandidateTeamOutcome,
  type QuestV2CandidateTeamSelectionOutcome,
} from './quest-candidate-team-v2.service';
import { WorkChatTransitionError } from './quest-work-chat.port';

type CandidateTeam = Extract<QuestV2CandidateTeamOutcome, { id: string }>;
type CandidateTeamError = Exclude<QuestV2CandidateTeamOutcome, CandidateTeam>;
type SelectionSuccess = Extract<QuestV2CandidateTeamSelectionOutcome, { assignments: unknown[] }>;
type SelectionError = Exclude<QuestV2CandidateTeamSelectionOutcome, SelectionSuccess>;

const serializeTeam = (team: CandidateTeam) => ({
  id: team.id,
  questId: team.questId,
  leaderId: team.leaderId,
  headcount: team.headcount,
  state: team.state,
  joinCode: team.joinCode,
  joinCodeExpiresAt: team.joinCodeExpiresAt?.toISOString() ?? null,
  members: team.members.map((member) => ({
    memberId: member.memberId,
    joinedAt: member.joinedAt.toISOString(),
  })),
  submission: team.submission
    ? {
        text: team.submission.text,
        fileIds: team.submission.fileIds,
        submittedAt: team.submission.submittedAt.toISOString(),
      }
    : null,
  createdAt: team.createdAt.toISOString(),
});

const conflict = (set: AuthedContext['set'], code: string, message: string) => {
  set.status = 409;
  return apiError(code, message);
};

const requiredCommandId = (
  request: Request | undefined,
  set: AuthedContext['set'],
) => {
  const commandId = request?.headers.get('idempotency-key');
  if (commandId?.trim()) return commandId;
  set.status = 400;
  return apiError('IDEMPOTENCY_KEY_REQUIRED', 'The Idempotency-Key header is required');
};

const mapTeamError = (
  set: AuthedContext['set'],
  outcome: CandidateTeamError,
) => {
  if (outcome.outcome === 'not-found') {
    set.status = 404;
    return apiError('QUEST_NOT_FOUND', 'Quest not found');
  }
  if (outcome.outcome === 'team-not-found') {
    set.status = 404;
    return apiError('TEAM_NOT_FOUND', 'Candidate Team not found');
  }
  if (outcome.outcome === 'member-not-found') {
    set.status = 404;
    return apiError('TEAM_MEMBER_NOT_FOUND', 'Team Member not found');
  }
  if (outcome.outcome === 'not-authorized') {
    set.status = 404;
    return apiError('TEAM_NOT_FOUND', 'Candidate Team not found');
  }
  if (outcome.outcome === 'not-candidate') {
    return conflict(set, 'QUEST_MODE_NOT_ALLOWED', 'Only CANDIDATE Quests can form Candidate Teams');
  }
  if (outcome.outcome === 'not-group') {
    return conflict(set, 'QUEST_PARTICIPATION_NOT_ALLOWED', 'Only GROUP Candidate Quests can form Candidate Teams');
  }
  if (outcome.outcome === 'hirer-not-allowed') {
    return conflict(set, 'HIRER_CANNOT_JOIN_TEAM', 'The Hirer cannot join or form a Candidate Team');
  }
  if (outcome.outcome === 'not-open') {
    return conflict(set, 'QUEST_NOT_OPEN', 'Candidate Team commands are allowed only while the Quest is open');
  }
  if (outcome.outcome === 'already-member') {
    return conflict(set, 'TEAM_MEMBERSHIP_ALREADY_EXISTS', 'The Member already belongs to a Candidate Team for this Quest');
  }
  if (outcome.outcome === 'already-assigned') {
    return conflict(set, 'ASSIGNMENT_ALREADY_EXISTS', 'The Member already has an active Assignment for this Quest');
  }
  if (outcome.outcome === 'not-forming') {
    return conflict(set, 'TEAM_NOT_FORMING', 'The Candidate Team is no longer forming');
  }
  if (outcome.outcome === 'team-full') {
    return conflict(set, 'TEAM_FULL', 'The Candidate Team has reached its entered headcount');
  }
  if (outcome.outcome === 'join-code-invalid') {
    return conflict(set, 'JOIN_CODE_INVALID', 'The Join Code is invalid');
  }
  if (outcome.outcome === 'join-code-expired') {
    return conflict(set, 'JOIN_CODE_EXPIRED', 'The Join Code has expired');
  }
  if (outcome.outcome === 'not-leader') {
    return conflict(set, 'TEAM_LEADER_REQUIRED', 'Only the Team Leader can perform this command');
  }
  if (outcome.outcome === 'leader-removal-not-allowed') {
    return conflict(set, 'TEAM_LEADER_CANNOT_REMOVE_SELF', 'The Team Leader cannot remove themself');
  }
  if (outcome.outcome === 'headcount-not-allowed') {
    return conflict(set, 'TEAM_HEADCOUNT_NOT_ALLOWED', 'Team headcount must be from 2 through the published Quest headcount');
  }
  if (outcome.outcome === 'headcount-mismatch') {
    return conflict(set, 'TEAM_HEADCOUNT_MISMATCH', 'The Candidate Team must be full before submission');
  }
  if (outcome.outcome === 'submission-invalid') {
    return conflict(set, 'TEAM_SUBMISSION_INVALID', 'Team submission text is required and must be at most 1,000 characters');
  }
  if (outcome.outcome === 'submission-files-invalid') {
    return conflict(set, 'TEAM_SUBMISSION_FILES_INVALID', 'Team submission must contain valid Work Conversation Attachment files');
  }
  if (outcome.outcome === 'idempotency-key-reused') {
    return conflict(set, 'IDEMPOTENCY_KEY_REUSED', 'The Idempotency-Key was used for a different request');
  }
  if (outcome.outcome === 'idempotency-in-progress') {
    return conflict(set, 'IDEMPOTENCY_IN_PROGRESS', 'The Idempotency-Key is still processing');
  }
  if (outcome.outcome === 'idempotency-unavailable') {
    set.status = 503;
    return apiError('IDEMPOTENCY_UNAVAILABLE', 'The Idempotency-Key result is unavailable');
  }
  set.status = 400;
  return apiError('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must not be empty');
};

const mapSelectionError = (
  set: AuthedContext['set'],
  outcome: SelectionError,
) => {
  if (outcome.outcome === 'not-found') {
    set.status = 404;
    return apiError('QUEST_NOT_FOUND', 'Quest not found');
  }
  if (outcome.outcome === 'team-not-found') {
    set.status = 404;
    return apiError('TEAM_NOT_FOUND', 'Candidate Team not found');
  }
  if (outcome.outcome === 'not-authorized') {
    return conflict(set, 'CANDIDATE_SELECTION_NOT_ALLOWED', 'Only the owning Hirer can select a Candidate Team');
  }
  if (outcome.outcome === 'not-candidate') {
    return conflict(set, 'QUEST_MODE_NOT_ALLOWED', 'Only CANDIDATE Quests accept Candidate Team selection');
  }
  if (outcome.outcome === 'not-group') {
    return conflict(set, 'QUEST_PARTICIPATION_NOT_ALLOWED', 'Only GROUP Candidate Quests accept Candidate Team selection');
  }
  if (outcome.outcome === 'not-open') {
    return conflict(set, 'QUEST_NOT_OPEN', 'Candidate Team selection is allowed only while the Quest is open');
  }
  if (outcome.outcome === 'not-selectable') {
    return conflict(set, 'CANDIDATE_TEAM_NOT_SELECTABLE', 'The Candidate Team is not submitted for selection');
  }
  if (outcome.outcome === 'already-assigned') {
    return conflict(set, 'ASSIGNMENT_ALREADY_EXISTS', 'A Team Member is already assigned to this Quest');
  }
  if (outcome.outcome === 'headcount-mismatch') {
    return conflict(set, 'TEAM_HEADCOUNT_MISMATCH', 'The submitted Candidate Team is not full');
  }
  if (outcome.outcome === 'idempotency-key-reused') {
    return conflict(set, 'IDEMPOTENCY_KEY_REUSED', 'The Idempotency-Key was used for a different request');
  }
  if (outcome.outcome === 'idempotency-in-progress') {
    return conflict(set, 'IDEMPOTENCY_IN_PROGRESS', 'The Idempotency-Key is still processing');
  }
  if (outcome.outcome === 'idempotency-unavailable') {
    set.status = 503;
    return apiError('IDEMPOTENCY_UNAVAILABLE', 'The Idempotency-Key result is unavailable');
  }
  set.status = 400;
  return apiError('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must not be empty');
};

const serializeSelectionAssignment = (assignment: SelectionSuccess['assignments'][number]) => ({
  id: assignment.id,
  questId: assignment.questId,
  workerId: assignment.workerId,
  state: assignment.state,
  questState: assignment.questState,
  startedAt: assignment.startedAt?.toISOString() ?? null,
  createdAt: assignment.createdAt.toISOString(),
});

export const createQuestV2CandidateTeamController = async ({
  body,
  params,
  request,
  session,
  set,
}: AuthedContext & {
  body: QuestV2CandidateTeamCreateInput;
  params: QuestV2CandidateTeamParams;
}) => {
  const commandId = requiredCommandId(request, set);
  if (typeof commandId !== 'string') return commandId;
  const result = await createQuestV2CandidateTeam(session.user.id, params.questId, body, commandId);
  if ('outcome' in result) return mapTeamError(set, result);
  set.status = 201;
  return apiSuccess(serializeTeam(result));
};

export const listQuestV2CandidateTeamsController = async ({
  params,
  session,
  set,
}: AuthedContext & { params: QuestV2CandidateTeamParams }) => {
  const result = await listQuestV2CandidateTeams(session.user.id, params.questId);
  if ('outcome' in result) {
    set.status = 404;
    return apiError('QUEST_NOT_FOUND', 'Quest not found');
  }
  return apiSuccess({ items: result.map(serializeTeam) });
};

export const getQuestV2CandidateTeamController = async ({
  params,
  session,
  set,
}: AuthedContext & { params: QuestV2CandidateTeamDetailParams }) => {
  const result = await getQuestV2CandidateTeam(session.user.id, params.questId, params.teamId);
  if ('outcome' in result) {
    set.status = 404;
    return apiError(
      result.outcome === 'not-found' ? 'QUEST_NOT_FOUND' : 'TEAM_NOT_FOUND',
      result.outcome === 'not-found' ? 'Quest not found' : 'Candidate Team not found',
    );
  }
  return apiSuccess(serializeTeam(result));
};

export const joinQuestV2CandidateTeamController = async ({
  body,
  params,
  request,
  session,
  set,
}: AuthedContext & {
  body: QuestV2CandidateTeamJoinInput;
  params: QuestV2CandidateTeamDetailParams;
}) => {
  const commandId = requiredCommandId(request, set);
  if (typeof commandId !== 'string') return commandId;
  const result = await joinQuestV2CandidateTeam(
    session.user.id,
    params.questId,
    params.teamId,
    body,
    commandId,
  );
  if ('outcome' in result) return mapTeamError(set, result);
  return apiSuccess(serializeTeam(result));
};

export const leaveQuestV2CandidateTeamController = async ({
  params,
  request,
  session,
  set,
}: AuthedContext & { params: QuestV2CandidateTeamDetailParams }) => {
  const commandId = requiredCommandId(request, set);
  if (typeof commandId !== 'string') return commandId;
  const result = await leaveQuestV2CandidateTeam(
    session.user.id,
    params.questId,
    params.teamId,
    commandId,
  );
  if ('outcome' in result) return mapTeamError(set, result);
  return apiSuccess(serializeTeam(result));
};

export const removeQuestV2CandidateTeamMemberController = async ({
  params,
  request,
  session,
  set,
}: AuthedContext & { params: QuestV2CandidateTeamMemberParams }) => {
  const commandId = requiredCommandId(request, set);
  if (typeof commandId !== 'string') return commandId;
  const result = await removeQuestV2CandidateTeamMember(
    session.user.id,
    params.questId,
    params.teamId,
    params.memberId,
    commandId,
  );
  if ('outcome' in result) return mapTeamError(set, result);
  return apiSuccess(serializeTeam(result));
};

export const regenerateQuestV2CandidateTeamJoinCodeController = async ({
  params,
  request,
  session,
  set,
}: AuthedContext & { params: QuestV2CandidateTeamDetailParams }) => {
  const commandId = requiredCommandId(request, set);
  if (typeof commandId !== 'string') return commandId;
  const result = await regenerateQuestV2CandidateTeamJoinCode(
    session.user.id,
    params.questId,
    params.teamId,
    commandId,
  );
  if ('outcome' in result) return mapTeamError(set, result);
  return apiSuccess(serializeTeam(result));
};

export const submitQuestV2CandidateTeamController = async ({
  body,
  params,
  request,
  session,
  set,
}: AuthedContext & {
  body: QuestV2CandidateTeamSubmissionInput;
  params: QuestV2CandidateTeamDetailParams;
}) => {
  const commandId = requiredCommandId(request, set);
  if (typeof commandId !== 'string') return commandId;
  const result = await submitQuestV2CandidateTeam(
    session.user.id,
    params.questId,
    params.teamId,
    body,
    commandId,
  );
  if ('outcome' in result) return mapTeamError(set, result);
  return apiSuccess(serializeTeam(result));
};

export const selectQuestV2CandidateTeamController = async ({
  params,
  request,
  session,
  set,
}: AuthedContext & { params: QuestV2CandidateTeamDetailParams }) => {
  const commandId = requiredCommandId(request, set);
  if (typeof commandId !== 'string') return commandId;

  try {
    const result = await selectQuestV2CandidateTeam(
      session.user.id,
      params.questId,
      params.teamId,
      commandId,
    );
    if ('outcome' in result) return mapSelectionError(set, result);
    return apiSuccess({
      questState: result.questState,
      assignments: result.assignments.map(serializeSelectionAssignment),
    });
  } catch (error) {
    if (error instanceof WorkChatTransitionError) {
      set.status = 503;
      return apiError('WORK_CHAT_UNAVAILABLE', 'Work Chat membership could not be updated');
    }
    throw error;
  }
};
