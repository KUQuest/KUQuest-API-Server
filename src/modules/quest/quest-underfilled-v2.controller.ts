import type { AuthedContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';

import {
  decideQuestV2Underfilled,
  getQuestV2Underfilled,
  respondToQuestV2Underfilled,
  type QuestV2UnderfilledOutcome,
} from './quest-underfilled-v2.service';
import type {
  QuestV2UnderfilledConsentInput,
  QuestV2UnderfilledDecisionInput,
  QuestV2UnderfilledParams,
} from './quest-underfilled-v2.schema';
import { WorkChatTransitionError } from './quest-work-chat.port';

type UnderfilledData = Extract<QuestV2UnderfilledOutcome, { underfilled: unknown }>['underfilled'];
type UnderfilledError = Exclude<QuestV2UnderfilledOutcome, { underfilled: unknown }>;

const conflict = (set: AuthedContext['set'], code: string, message: string) => {
  set.status = 409;
  return apiError(code, message);
};

const mapOutcome = (set: AuthedContext['set'], result: UnderfilledError) => {
  if (result.outcome === 'not-found' || result.outcome === 'not-authorized') {
    set.status = 404;
    return apiError('QUEST_UNDERFILLED_NOT_FOUND', 'The underfilled Quest process was not found');
  }
  if (result.outcome === 'not-underfilled') {
    return conflict(set, 'QUEST_NOT_UNDERFILLED', 'The Quest is not an underfilled GROUP + FIRST_COME_FIRST_SERVED Quest');
  }
  if (result.outcome === 'not-pending') {
    return conflict(set, 'QUEST_UNDERFILLED_NOT_PENDING', 'The underfilled decision or consent window is not pending');
  }
  if (result.outcome === 'already-responded') {
    return conflict(set, 'QUEST_UNDERFILLED_ALREADY_RESPONDED', 'The Worker already responded to this consent window');
  }
  if (result.outcome === 'expired') {
    return conflict(set, 'QUEST_UNDERFILLED_EXPIRED', 'The underfilled decision or consent window has expired');
  }
  if (result.outcome === 'idempotency-key-reused') {
    return conflict(set, 'IDEMPOTENCY_KEY_REUSED', 'The Idempotency-Key was used for a different request');
  }
  if (result.outcome === 'idempotency-in-progress') {
    return conflict(set, 'IDEMPOTENCY_IN_PROGRESS', 'The Idempotency-Key is still processing');
  }
  if (result.outcome === 'idempotency-unavailable' || result.outcome === 'invalid-funding') {
    set.status = 503;
    return apiError('IDEMPOTENCY_UNAVAILABLE', 'The underfilled command result is unavailable');
  }
  set.status = 400;
  return apiError('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must not be empty');
};

const commandId = (request: Request | undefined) => request?.headers.get('idempotency-key');

const requireCommandId = (set: AuthedContext['set'], request: Request | undefined) => {
  const value = commandId(request);
  if (value?.trim()) return value;
  set.status = 400;
  return apiError('IDEMPOTENCY_KEY_REQUIRED', 'The Idempotency-Key header is required');
};

const handleWorkChatError = (set: AuthedContext['set'], error: unknown) => {
  if (!(error instanceof WorkChatTransitionError)) return undefined;
  set.status = 503;
  return apiError('WORK_CHAT_UNAVAILABLE', 'Work Chat membership could not be updated');
};

export const getQuestUnderfilledV2Controller = async ({
  params,
  session,
  set,
}: AuthedContext & { params: QuestV2UnderfilledParams }) => {
  try {
    const result = await getQuestV2Underfilled(session.user.id, params.questId);
    if ('outcome' in result) return mapOutcome(set, result);
    return apiSuccess(result.underfilled as UnderfilledData);
  } catch (error) {
    const response = handleWorkChatError(set, error);
    if (response) return response;
    throw error;
  }
};

export const decideQuestUnderfilledV2Controller = async ({
  params,
  request,
  session,
  body,
  set,
}: AuthedContext & {
  params: QuestV2UnderfilledParams;
  body: QuestV2UnderfilledDecisionInput;
}) => {
  const key = requireCommandId(set, request);
  if (typeof key !== 'string') return key;
  try {
    const result = await decideQuestV2Underfilled(session.user.id, params.questId, body, key);
    if ('outcome' in result) return mapOutcome(set, result);
    return apiSuccess(result.underfilled as UnderfilledData);
  } catch (error) {
    const response = handleWorkChatError(set, error);
    if (response) return response;
    throw error;
  }
};

export const respondToQuestUnderfilledV2Controller = async ({
  params,
  request,
  session,
  body,
  set,
}: AuthedContext & {
  params: QuestV2UnderfilledParams;
  body: QuestV2UnderfilledConsentInput;
}) => {
  const key = requireCommandId(set, request);
  if (typeof key !== 'string') return key;
  try {
    const result = await respondToQuestV2Underfilled(session.user.id, params.questId, body, key);
    if ('outcome' in result) return mapOutcome(set, result);
    return apiSuccess(result.underfilled as UnderfilledData);
  } catch (error) {
    const response = handleWorkChatError(set, error);
    if (response) return response;
    throw error;
  }
};
