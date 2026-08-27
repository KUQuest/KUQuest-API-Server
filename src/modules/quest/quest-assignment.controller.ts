import type { AuthedContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';

import type { QuestAssignmentParams } from './quest-assignment.schema';
import {
  joinNoCandidateQuest,
  WorkChatTransitionError,
} from './quest-assignment.service';

const conflict = (set: AuthedContext['set'], code: string, message: string) => {
  set.status = 409;
  return apiError(code, message);
};

export const joinNoCandidateQuestController = async ({
  params,
  request,
  session,
  set,
}: AuthedContext & { params: QuestAssignmentParams }): Promise<ApiResponse> => {
  const commandId = request?.headers.get('idempotency-key');
  if (!commandId?.trim()) {
    set.status = 400;
    return apiError('IDEMPOTENCY_KEY_REQUIRED', 'The Idempotency-Key header is required');
  }

  try {
    const result = await joinNoCandidateQuest(session.user.id, params.questId, {
      commandId,
    });

    if (!('outcome' in result)) {
      return apiSuccess({
        ...result,
        startedAt: result.startedAt?.toISOString() ?? null,
        createdAt: result.createdAt.toISOString(),
      });
    }

    if (result.outcome === 'idempotency-key-required') {
      set.status = 400;
      return apiError('IDEMPOTENCY_KEY_REQUIRED', 'The Idempotency-Key header is required');
    }
    if (result.outcome === 'not-found') {
      set.status = 404;
      return apiError('QUEST_NOT_FOUND', 'Quest not found');
    }
    if (result.outcome === 'not-direct-join') {
      return conflict(set, 'DIRECT_JOIN_NOT_ALLOWED', 'Only NO_CANDIDATE Quests accept direct joins');
    }
    if (result.outcome === 'not-open') {
      return conflict(set, 'QUEST_NOT_OPEN', 'Only an open Quest can accept a direct join');
    }
    if (result.outcome === 'hirer-not-allowed') {
      return conflict(set, 'HIRER_CANNOT_JOIN', 'The Hirer cannot join their own Quest');
    }
    if (result.outcome === 'already-assigned') {
      return conflict(set, 'ASSIGNMENT_ALREADY_EXISTS', 'The Worker is already assigned to this Quest');
    }
    if (result.outcome === 'idempotency-key-reused') {
      return conflict(set, 'IDEMPOTENCY_KEY_REUSED', 'The Idempotency-Key was used for a different request');
    }
    if (result.outcome === 'idempotency-unavailable') {
      set.status = 503;
      return apiError('IDEMPOTENCY_UNAVAILABLE', 'The Idempotency-Key result is unavailable');
    }
    return conflict(set, 'QUEST_FULL', 'The Quest has no open Worker slots');
  } catch (error) {
    if (error instanceof WorkChatTransitionError) {
      set.status = 503;
      return apiError('WORK_CHAT_UNAVAILABLE', 'Work Chat membership could not be updated');
    }
    throw error;
  }
};

export const joinQuestDirectlyController = joinNoCandidateQuestController;
