import type { AuthedContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';

import {
  joinQuestV2,
  listMyQuestV2Assignments,
  listQuestV2Assignments,
  type QuestV2AssignmentOutcome,
} from './quest-assignment-v2.service';
import type { QuestV2AssignmentParams } from './quest-assignment-v2.schema';
import { WorkChatTransitionError } from './quest-work-chat.port';

type QuestV2Assignment = Extract<QuestV2AssignmentOutcome, { id: string }>;
type QuestV2AssignmentError = Exclude<QuestV2AssignmentOutcome, QuestV2Assignment>;

const serializeAssignment = (assignment: QuestV2Assignment) => ({
  id: assignment.id,
  questId: assignment.questId,
  workerId: assignment.workerId,
  state: assignment.state,
  questState: assignment.questState,
  startedAt: assignment.startedAt?.toISOString() ?? null,
  createdAt: assignment.createdAt.toISOString(),
});

const conflict = (set: AuthedContext['set'], code: string, message: string) => {
  set.status = 409;
  return apiError(code, message);
};

const mapJoinOutcome = (
  set: AuthedContext['set'],
  outcome: QuestV2AssignmentError,
) => {
  if (outcome.outcome === 'not-found') {
    set.status = 404;
    return apiError('QUEST_NOT_FOUND', 'Quest not found');
  }
  if (outcome.outcome === 'not-first-come-first-served') {
    return conflict(set, 'QUEST_MODE_NOT_ALLOWED', 'Only FIRST_COME_FIRST_SERVED Quests accept direct joins');
  }
  if (outcome.outcome === 'not-supported-participation') {
    return conflict(set, 'QUEST_PARTICIPATION_NOT_ALLOWED', 'Only SINGLE or GROUP Quests accept direct joins');
  }
  if (outcome.outcome === 'hirer-not-allowed') {
    return conflict(set, 'HIRER_CANNOT_JOIN', 'The Hirer cannot join their own Quest');
  }
  if (outcome.outcome === 'not-open') {
    return conflict(set, 'QUEST_NOT_OPEN', 'Only an open Quest can accept a direct join');
  }
  if (outcome.outcome === 'already-assigned') {
    return conflict(set, 'ASSIGNMENT_ALREADY_EXISTS', 'The Worker is already assigned to this Quest');
  }
  if (outcome.outcome === 'full') {
    return conflict(set, 'QUEST_FULL', 'The Quest has no open Worker slots');
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

export const joinQuestV2Controller = async ({
  params,
  request,
  session,
  set,
}: AuthedContext & { params: QuestV2AssignmentParams }) => {
  const commandId = request?.headers.get('idempotency-key');
  if (!commandId?.trim()) {
    set.status = 400;
    return apiError('IDEMPOTENCY_KEY_REQUIRED', 'The Idempotency-Key header is required');
  }

  try {
    const result = await joinQuestV2(session.user.id, params.questId, commandId);
    if ('outcome' in result) return mapJoinOutcome(set, result);
    return apiSuccess(serializeAssignment(result));
  } catch (error) {
    if (error instanceof WorkChatTransitionError) {
      set.status = 503;
      return apiError('WORK_CHAT_UNAVAILABLE', 'Work Chat membership could not be updated');
    }
    throw error;
  }
};

const mapReadOutcome = (set: AuthedContext['set']) => {
  set.status = 404;
  return apiError('QUEST_NOT_FOUND', 'Quest not found');
};

export const listQuestV2AssignmentsController = async ({
  params,
  session,
  set,
}: AuthedContext & { params: QuestV2AssignmentParams }) => {
  const result = await listQuestV2Assignments(session.user.id, params.questId);
  if ('outcome' in result) return mapReadOutcome(set);
  return apiSuccess({ items: result.map(serializeAssignment) });
};

export const listMyQuestV2AssignmentsController = async ({ session }: AuthedContext) =>
  apiSuccess({ items: (await listMyQuestV2Assignments(session.user.id)).map(serializeAssignment) });
