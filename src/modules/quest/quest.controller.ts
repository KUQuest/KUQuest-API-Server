import type { AuthedContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';
import { CursorInputError, decodeCursor, parsePageLimit } from '@/shared/cursor';

import type { Static } from 'elysia';

import type {
  questBoardResponseSchema,
  questCreateResponseSchema,
  questCreateSchema,
  questDetailResponseSchema,
  questListQuerySchema,
  questMineQuerySchema,
  questMineResponseSchema,
  questParamsSchema,
} from './quest.schema';
import {
  createQuest,
  getQuestDetail,
  listBoardQuests,
  listOwnQuests,
} from './quest.service';

type CreateResponse = Static<typeof questCreateResponseSchema>['data'];
type BoardResponse = Static<typeof questBoardResponseSchema>['data'];
type MineResponse = Static<typeof questMineResponseSchema>['data'];
type DetailResponse = Static<typeof questDetailResponseSchema>['data'];
type CreateInput = Static<typeof questCreateSchema>;
type ListQuery = Static<typeof questListQuerySchema>;
type MineQuery = Static<typeof questMineQuerySchema>;
type QuestParams = Static<typeof questParamsSchema>;

const invalidInput = (set: AuthedContext['set'], code: string, message: string) => {
  set.status = 400;
  return apiError(code, message);
};

const toFilters = (query: ListQuery) => ({
  ...query,
  startFrom: query.startFrom ? new Date(query.startFrom) : undefined,
  startTo: query.startTo ? new Date(query.startTo) : undefined,
});

const validateListQuery = (query: ListQuery, set: AuthedContext['set']) => {
  if ((query.latitude === undefined) !== (query.longitude === undefined)) {
    return invalidInput(set, 'INVALID_COORDINATES', 'latitude and longitude must be supplied together');
  }

  try {
    parsePageLimit(query.limit);
    decodeCursor(query.cursor);
  } catch (error) {
    if (error instanceof CursorInputError) return invalidInput(set, error.code, error.message);
    throw error;
  }

  return undefined;
};

const validateMineQuery = (query: MineQuery, set: AuthedContext['set']) => {
  try {
    parsePageLimit(query.limit);
    decodeCursor(query.cursor);
  } catch (error) {
    if (error instanceof CursorInputError) return invalidInput(set, error.code, error.message);
    throw error;
  }

  return undefined;
};

export const createQuestController = async ({
  body,
  session,
  set,
}: AuthedContext & { body: CreateInput }): Promise<ApiResponse<CreateResponse>> => {
  const result = await createQuest(session.user.id, body);

  if ('outcome' in result) {
    if (result.outcome === 'tag-not-found') {
      return invalidInput(set, 'TAG_NOT_FOUND', 'Tag not found');
    }
    if (result.outcome === 'invalid-dates') {
      return invalidInput(set, 'INVALID_QUEST_DATES', 'dueAt must be after startTime');
    }

    return invalidInput(set, 'INVALID_HEADCOUNT', 'SINGLE participation requires headcount 1');
  }

  return apiSuccess(result);
};

export const listBoardQuestsController = async ({
  query,
  set,
}: AuthedContext & { query: ListQuery }): Promise<ApiResponse<BoardResponse>> => {
  const invalid = validateListQuery(query, set);
  if (invalid) return invalid;

  return apiSuccess(await listBoardQuests(toFilters(query)));
};

export const listOwnQuestsController = async ({
  query,
  session,
  set,
}: AuthedContext & { query: MineQuery }): Promise<ApiResponse<MineResponse>> => {
  const invalid = validateMineQuery(query, set);
  if (invalid) return invalid;

  return apiSuccess(await listOwnQuests(session.user.id, query));
};

export const getQuestDetailController = async ({
  params,
  session,
  set,
}: AuthedContext & { params: QuestParams }): Promise<ApiResponse<DetailResponse>> => {
  const questDetail = await getQuestDetail(session.user.id, params.questId);
  if (!questDetail) {
    set.status = 404;
    return apiError('QUEST_NOT_FOUND', 'Quest not found');
  }

  return apiSuccess(questDetail);
};
