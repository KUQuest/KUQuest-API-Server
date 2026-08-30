import type { AuthedContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';
import { CursorInputError, decodeCursor, parsePageLimit } from '@/shared/cursor';

import type { Static } from 'elysia';

import {
  createQuestV2,
  getQuestV2Detail,
  listOwnQuestV2,
} from './quest-v2.service';
import type {
  questV2CreateResponseSchema,
  questV2CreateSchema,
  questV2DetailResponseSchema,
  questV2MineQuerySchema,
  questV2MineResponseSchema,
  questV2ParamsSchema,
  questV2WriteHeadersSchema,
} from './quest-v2.schema';

type QuestV2CreateResponse = Static<typeof questV2CreateResponseSchema>['data'];
type QuestV2CreateInput = Static<typeof questV2CreateSchema>;
type QuestV2MineQuery = Static<typeof questV2MineQuerySchema>;
type QuestV2MineResponse = Static<typeof questV2MineResponseSchema>['data'];
type QuestV2Params = Static<typeof questV2ParamsSchema>;
type QuestV2WriteHeaders = Static<typeof questV2WriteHeadersSchema>;
type QuestV2DetailResponse = Static<typeof questV2DetailResponseSchema>['data'];

const invalidInput = (set: AuthedContext['set'], code: string, message: string) => {
  set.status = 400;
  return apiError(code, message);
};

const mapCreateOutcome = (
  set: AuthedContext['set'],
  outcome: Exclude<Awaited<ReturnType<typeof createQuestV2>>, { quest: unknown }>['outcome'],
) => {
  if (outcome === 'idempotency-key-reused') {
    set.status = 409;
    return apiError('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with a different request');
  }
  if (outcome === 'idempotency-in-progress') {
    set.status = 409;
    return apiError('IDEMPOTENCY_IN_PROGRESS', 'A Quest with this idempotency key is still processing');
  }
  if (outcome === 'idempotency-unavailable') {
    set.status = 503;
    return apiError('IDEMPOTENCY_UNAVAILABLE', 'Idempotency record is unavailable');
  }
  if (outcome === 'tag-not-found') return invalidInput(set, 'TAG_NOT_FOUND', 'Tag not found');
  if (outcome === 'invalid-dates') {
    return invalidInput(set, 'INVALID_QUEST_DATES', 'dueAt must be after startTime');
  }
  if (outcome === 'invalid-headcount') {
    return invalidInput(set, 'INVALID_HEADCOUNT', 'SINGLE participation requires headcount 1');
  }
  if (outcome === 'invalid-funding') {
    return invalidInput(
      set,
      'INVALID_QUEST_FUNDING_TOTAL',
      'questFundingTotal must use exact satang precision between 1 and 700000 Baht',
    );
  }
  if (outcome === 'invalid-idempotency-key') {
    return invalidInput(set, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency key must not be empty');
  }
  if (outcome === 'invalid-title') {
    return invalidInput(set, 'INVALID_TITLE', 'title must contain 1 to 120 characters');
  }
  if (outcome === 'invalid-description') {
    return invalidInput(set, 'INVALID_DESCRIPTION', 'description must contain at most 1000 characters');
  }
  if (outcome === 'invalid-location') {
    return invalidInput(set, 'INVALID_LOCATIONS', 'locations must contain at most 10 labels');
  }

  return invalidInput(set, 'INVALID_CONDITION', 'At least one valid Condition Item is required');
};

export const createQuestV2Controller = async ({
  body,
  headers,
  session,
  set,
}: AuthedContext & {
  body: QuestV2CreateInput;
  headers: QuestV2WriteHeaders;
}): Promise<ApiResponse<QuestV2CreateResponse>> => {
  const result = await createQuestV2(session.user.id, body, headers['idempotency-key']);
  if ('outcome' in result) return mapCreateOutcome(set, result.outcome);

  return apiSuccess(result.quest);
};

const validateMineQuery = (query: QuestV2MineQuery, set: AuthedContext['set']) => {
  try {
    parsePageLimit(query.limit);
    decodeCursor(query.cursor);
  } catch (error) {
    if (error instanceof CursorInputError) return invalidInput(set, error.code, error.message);
    throw error;
  }

  return undefined;
};

export const listOwnQuestV2Controller = async ({
  query,
  session,
  set,
}: AuthedContext & {
  query: QuestV2MineQuery;
}): Promise<ApiResponse<QuestV2MineResponse>> => {
  const validationError = validateMineQuery(query, set);
  if (validationError) return validationError;

  return apiSuccess(await listOwnQuestV2(session.user.id, query));
};

export const getQuestV2DetailController = async ({
  params,
  session,
  set,
}: AuthedContext & {
  params: QuestV2Params;
}): Promise<ApiResponse<QuestV2DetailResponse>> => {
  const questDetail = await getQuestV2Detail(session.user.id, params.questId);
  if (!questDetail) {
    set.status = 404;
    return apiError('QUEST_NOT_FOUND', 'Quest not found');
  }

  return apiSuccess(questDetail);
};
