import { type AdminContext, type AuthedContext } from '@/modules/auth';
import { MoneyDomainError } from '@/modules/wallet';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';
import type { Static } from 'elysia';

import { WorkChatTransitionError } from './quest-assignment.service';
import {
  cancelQuest,
  cancelQuestV2,
  resolveQuestDispute,
} from './quest-settlement.service';
import type {
  questDisputeResolutionSchema,
  questSettlementParamsSchema,
} from './quest-settlement.schema';

type Params = Static<typeof questSettlementParamsSchema>;
type DisputeInput = Static<typeof questDisputeResolutionSchema>;

const errorResponse = (set: AuthedContext['set'] | AdminContext['set'], outcome: string) => {
  if (outcome === 'not-found') {
    set.status = 404;
    return apiError('QUEST_NOT_FOUND', 'Quest not found');
  }
  if (outcome === 'not-authorized') {
    set.status = 403;
    return apiError('QUEST_NOT_AUTHORIZED', 'You are not the Hirer of this Quest');
  }
  if (outcome === 'idempotency-key-required') {
    set.status = 400;
    return apiError('IDEMPOTENCY_KEY_REQUIRED', 'The Idempotency-Key header is required');
  }
  if (outcome === 'idempotency-key-reused') {
    set.status = 409;
    return apiError('IDEMPOTENCY_KEY_REUSED', 'The Idempotency-Key was used for a different request');
  }
  if (outcome === 'allocations-invalid') {
    set.status = 400;
    return apiError('DISPUTE_ALLOCATIONS_INVALID', 'Dispute allocations must name active Workers and fit the reserved amount');
  }
  if (outcome === 'idempotency-unavailable') {
    set.status = 503;
    return apiError('IDEMPOTENCY_UNAVAILABLE', 'The Idempotency-Key result is unavailable');
  }
  set.status = 409;
  return apiError('QUEST_SETTLEMENT_NOT_ALLOWED', 'The Quest is not in a state that accepts this settlement');
};

const moneyError = (set: AuthedContext['set'] | AdminContext['set'], error: unknown) => {
  if (error instanceof WorkChatTransitionError) {
    set.status = 503;
    return apiError('WORK_CHAT_UNAVAILABLE', 'Work Chat membership could not be updated');
  }
  if (!(error instanceof MoneyDomainError)) throw error;
  set.status = 409;
  return apiError(error.code, error.message);
};

const v2CancellationErrorResponse = (set: AuthedContext['set'], outcome: string) => {
  if (outcome === 'invalid-idempotency-key') {
    set.status = 400;
    return apiError('INVALID_IDEMPOTENCY_KEY', 'The Idempotency-Key must be at most 200 characters');
  }
  return errorResponse(set, outcome);
};

export const cancelQuestController = async ({ params, request, session, set }: AuthedContext & { params: Params }): Promise<ApiResponse> => {
  const commandId = request?.headers.get('idempotency-key') ?? '';
  try {
    const result = await cancelQuest(session.user.id, params.questId, commandId);
    if (!('questStatus' in result)) return errorResponse(set, result.outcome);
    return apiSuccess(result);
  } catch (error) {
    return moneyError(set, error);
  }
};

export const cancelQuestV2Controller = async ({ params, request, session, set }: AuthedContext & { params: Params }): Promise<ApiResponse> => {
  const commandId = request?.headers.get('idempotency-key') ?? '';
  try {
    const result = await cancelQuestV2(session.user.id, params.questId, commandId);
    if (!('questStatus' in result)) return v2CancellationErrorResponse(set, result.outcome);
    return apiSuccess(result);
  } catch (error) {
    return moneyError(set, error);
  }
};

export const resolveQuestDisputeController = async ({ body, params, request, admin, set }: AdminContext & { body: DisputeInput; params: Params; request: Request }): Promise<ApiResponse> => {
  const commandId = request.headers.get('idempotency-key') ?? '';
  try {
    const result = await resolveQuestDispute(admin.id, params.questId, commandId, body.outcome, body.allocations ?? []);
    if (!('questStatus' in result)) return errorResponse(set, result.outcome);
    return apiSuccess(result);
  } catch (error) {
    return moneyError(set, error);
  }
};

export const settlementErrorResponse = errorResponse;
