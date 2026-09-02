import type { AuthedContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';

import type {
  QuestV2CandidateApplicationDetailParams,
  QuestV2CandidateApplicationParams,
  QuestV2CandidateSelectionParams,
} from './quest-candidate-v2.schema';
import {
  createQuestV2CandidateApplication,
  getQuestV2CandidateApplication,
  listQuestV2CandidateApplications,
  selectQuestV2CandidateApplication,
  withdrawQuestV2CandidateApplication,
  type QuestV2CandidateApplicationOutcome,
  type QuestV2CandidateSelectionOutcome,
} from './quest-candidate-v2.service';
import { WorkChatTransitionError } from './quest-work-chat.port';

type Application = Extract<QuestV2CandidateApplicationOutcome, { id: string }>;
type ApplicationError = Exclude<QuestV2CandidateApplicationOutcome, Application>;
type WithdrawOutcome = Awaited<ReturnType<typeof withdrawQuestV2CandidateApplication>>;
type WithdrawError = Exclude<WithdrawOutcome, Application>;
type SelectionError = Exclude<QuestV2CandidateSelectionOutcome, { assignments: unknown[] }>;

const serializeApplication = (application: Application) => ({
  id: application.id,
  questId: application.questId,
  workerId: application.workerId,
  state: application.state,
  appliedAt: application.appliedAt.toISOString(),
});

const conflict = (set: AuthedContext['set'], code: string, message: string) => {
  set.status = 409;
  return apiError(code, message);
};

const mapApplicationError = (
  set: AuthedContext['set'],
  outcome: ApplicationError,
) => {
  if (outcome.outcome === 'not-found') {
    set.status = 404;
    return apiError('QUEST_NOT_FOUND', 'Quest not found');
  }
  if (outcome.outcome === 'not-candidate') {
    return conflict(set, 'QUEST_MODE_NOT_ALLOWED', 'Only CANDIDATE Quests accept applications');
  }
  if (outcome.outcome === 'not-single') {
    return conflict(set, 'QUEST_PARTICIPATION_NOT_ALLOWED', 'Only SINGLE Candidate Quests accept applications');
  }
  if (outcome.outcome === 'hirer-not-allowed') {
    return conflict(set, 'HIRER_CANNOT_APPLY', 'The Hirer cannot apply to their own Quest');
  }
  if (outcome.outcome === 'not-open') {
    return conflict(set, 'QUEST_NOT_OPEN', 'Only an open Quest accepts Candidate applications');
  }
  if (outcome.outcome === 'already-exists') {
    return conflict(set, 'APPLICATION_ALREADY_EXISTS', 'The Member already has an application for this Quest');
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

export const createQuestV2CandidateApplicationController = async ({
  params,
  request,
  session,
  set,
}: AuthedContext & { params: QuestV2CandidateApplicationParams }) => {
  const commandId = request?.headers.get('idempotency-key');
  if (!commandId?.trim()) {
    set.status = 400;
    return apiError('IDEMPOTENCY_KEY_REQUIRED', 'The Idempotency-Key header is required');
  }

  const result = await createQuestV2CandidateApplication(
    session.user.id,
    params.questId,
    commandId,
  );
  if ('outcome' in result) return mapApplicationError(set, result);
  return apiSuccess(serializeApplication(result));
};

export const listQuestV2CandidateApplicationsController = async ({
  params,
  session,
  set,
}: AuthedContext & { params: QuestV2CandidateApplicationParams }) => {
  const result = await listQuestV2CandidateApplications(session.user.id, params.questId);
  if ('outcome' in result) {
    set.status = 404;
    return apiError('QUEST_NOT_FOUND', 'Quest not found');
  }
  return apiSuccess({ items: result.map(serializeApplication) });
};

export const getQuestV2CandidateApplicationController = async ({
  params,
  session,
  set,
}: AuthedContext & { params: QuestV2CandidateApplicationDetailParams }) => {
  const result = await getQuestV2CandidateApplication(
    session.user.id,
    params.questId,
    params.applicationId,
  );
  if ('outcome' in result) {
    set.status = 404;
    return apiError(
      result.outcome === 'not-found' ? 'QUEST_NOT_FOUND' : 'APPLICATION_NOT_FOUND',
      result.outcome === 'not-found' ? 'Quest not found' : 'Application not found',
    );
  }
  return apiSuccess(serializeApplication(result));
};

const mapWithdrawError = (
  set: AuthedContext['set'],
  outcome: WithdrawError,
) => {
  if (outcome.outcome === 'not-found') {
    set.status = 404;
    return apiError('QUEST_NOT_FOUND', 'Quest not found');
  }
  if (outcome.outcome === 'application-not-found') {
    set.status = 404;
    return apiError('APPLICATION_NOT_FOUND', 'Application not found');
  }
  if (outcome.outcome === 'not-withdrawable') {
    return conflict(set, 'APPLICATION_NOT_WITHDRAWABLE', 'Only an applied application can be withdrawn');
  }
  if (outcome.outcome === 'not-candidate') {
    return conflict(set, 'QUEST_MODE_NOT_ALLOWED', 'Only CANDIDATE Quests accept applications');
  }
  if (outcome.outcome === 'not-single') {
    return conflict(set, 'QUEST_PARTICIPATION_NOT_ALLOWED', 'Only SINGLE Candidate Quests accept applications');
  }
  if (outcome.outcome === 'hirer-not-allowed') {
    return conflict(set, 'HIRER_CANNOT_WITHDRAW', 'The Hirer cannot withdraw a Candidate application');
  }
  if (outcome.outcome === 'not-open') {
    return conflict(set, 'QUEST_NOT_OPEN', 'Applications can be withdrawn only while the Quest is open');
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

export const withdrawQuestV2CandidateApplicationController = async ({
  params,
  request,
  session,
  set,
}: AuthedContext & { params: QuestV2CandidateApplicationDetailParams }) => {
  const commandId = request?.headers.get('idempotency-key');
  if (!commandId?.trim()) {
    set.status = 400;
    return apiError('IDEMPOTENCY_KEY_REQUIRED', 'The Idempotency-Key header is required');
  }

  const result = await withdrawQuestV2CandidateApplication(
    session.user.id,
    params.questId,
    params.applicationId,
    commandId,
  );
  if ('outcome' in result) return mapWithdrawError(set, result);
  return apiSuccess(serializeApplication(result));
};

const serializeSelectionAssignment = (assignment: {
  id: string;
  questId: string;
  workerId: string;
  state: string;
  questState: 'QUEST_ASSIGNED';
  startedAt: Date | null;
  createdAt: Date;
}) => ({
  id: assignment.id,
  questId: assignment.questId,
  workerId: assignment.workerId,
  state: assignment.state,
  questState: assignment.questState,
  startedAt: assignment.startedAt?.toISOString() ?? null,
  createdAt: assignment.createdAt.toISOString(),
});

const mapSelectionError = (
  set: AuthedContext['set'],
  outcome: SelectionError,
) => {
  if (outcome.outcome === 'not-found') {
    set.status = 404;
    return apiError('QUEST_NOT_FOUND', 'Quest not found');
  }
  if (outcome.outcome === 'application-not-found') {
    set.status = 404;
    return apiError('APPLICATION_NOT_FOUND', 'Application not found');
  }
  if (outcome.outcome === 'not-allowed') {
    return conflict(set, 'CANDIDATE_SELECTION_NOT_ALLOWED', 'Only the owning Hirer can select a Candidate application');
  }
  if (outcome.outcome === 'not-open') {
    return conflict(set, 'QUEST_NOT_OPEN', 'Candidate selection is allowed only while the Quest is open');
  }
  if (outcome.outcome === 'not-selectable') {
    return conflict(set, 'CANDIDATE_NOT_SELECTABLE', 'The Candidate application is not available for selection');
  }
  if (outcome.outcome === 'already-assigned') {
    return conflict(set, 'ASSIGNMENT_ALREADY_EXISTS', 'The Candidate is already assigned to this Quest');
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

export const selectQuestV2CandidateApplicationController = async ({
  params,
  request,
  session,
  set,
}: AuthedContext & { params: QuestV2CandidateSelectionParams }) => {
  const commandId = request?.headers.get('idempotency-key');
  if (!commandId?.trim()) {
    set.status = 400;
    return apiError('IDEMPOTENCY_KEY_REQUIRED', 'The Idempotency-Key header is required');
  }

  try {
    const result = await selectQuestV2CandidateApplication(
      session.user.id,
      params.questId,
      params.applicationId,
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
