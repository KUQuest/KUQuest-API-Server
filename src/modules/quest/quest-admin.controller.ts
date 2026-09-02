import type { AdminContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';
import { CursorInputError, decodeCursor, encodeCursor, parsePageLimit } from '@/shared/cursor';

import type { Static } from 'elysia';

import { getAdminQuestDetail, listAdminQuests } from './quest-admin.service';
import type { AdminQuestDetail, AdminQuestEditHistoryEntry, AdminQuestSummary } from './quest-admin.service';
import type {
  adminQuestDetailResponseSchema,
  adminQuestListQuerySchema,
  adminQuestListResponseSchema,
  adminQuestParamsSchema,
} from './quest-admin.schema';

type AdminQuestParams = Static<typeof adminQuestParamsSchema>;
type AdminQuestListQuery = Static<typeof adminQuestListQuerySchema>;
type AdminQuestListResponse = Static<typeof adminQuestListResponseSchema>['data'];
type AdminQuestDetailResponse = Static<typeof adminQuestDetailResponseSchema>['data'];

const questNotFound = (set: AdminContext['set']) => {
  set.status = 404;
  return apiError('QUEST_NOT_FOUND', 'Quest not found');
};

const serializeEditHistoryEntry = (entry: AdminQuestEditHistoryEntry) => entry.kind === 'FIELD_EDIT'
  ? { ...entry, editedAt: entry.editedAt.toISOString() }
  : {
      ...entry,
      createdAt: entry.createdAt.toISOString(),
      expiresAt: entry.expiresAt ? entry.expiresAt.toISOString() : null,
      resolvedAt: entry.resolvedAt ? entry.resolvedAt.toISOString() : null,
      responses: entry.responses.map((response) => ({
        ...response,
        respondedAt: response.respondedAt ? response.respondedAt.toISOString() : null,
      })),
    };

const serializeQuestSummary = (quest: AdminQuestSummary) => ({
  ...quest,
  startTime: quest.startTime.toISOString(),
  dueAt: quest.dueAt ? quest.dueAt.toISOString() : null,
  hiddenAt: quest.hiddenAt ? quest.hiddenAt.toISOString() : null,
  createdAt: quest.createdAt.toISOString(),
  updatedAt: quest.updatedAt.toISOString(),
});

const serializeQuestDetail = (quest: AdminQuestDetail): AdminQuestDetailResponse => ({
  ...quest,
  ...serializeQuestSummary(quest),
  cancelledAt: quest.cancelledAt ? quest.cancelledAt.toISOString() : null,
  candidates: {
    applications: quest.candidates.applications.map((application) => ({
      ...application,
      appliedAt: application.appliedAt.toISOString(),
    })),
    teams: quest.candidates.teams.map((team) => ({
      ...team,
      createdAt: team.createdAt.toISOString(),
      members: team.members.map((entry) => ({
        member: entry.member,
        joinedAt: entry.joinedAt.toISOString(),
      })),
    })),
  },
  assignments: quest.assignments.map((assignment) => ({
    ...assignment,
    startedAt: assignment.startedAt ? assignment.startedAt.toISOString() : null,
    createdAt: assignment.createdAt.toISOString(),
  })),
  proofSubmissions: quest.proofSubmissions.map((proof) => ({
    ...proof,
    submittedAt: proof.submittedAt.toISOString(),
    reviewedAt: proof.reviewedAt ? proof.reviewedAt.toISOString() : null,
  })),
  editHistory: quest.editHistory.map(serializeEditHistoryEntry),
  adminActions: quest.adminActions.map((action) => ({ ...action, createdAt: action.createdAt.toISOString() })),
});

export const listAdminQuestsController = async ({
  query,
  set,
}: AdminContext & { query: AdminQuestListQuery }): Promise<ApiResponse<AdminQuestListResponse>> => {
  try {
    const result = await listAdminQuests({
      status: query.status,
      mode: query.mode,
      participation: query.participation,
      hidden: query.hidden,
      limit: parsePageLimit(query.limit),
      cursor: decodeCursor(query.cursor),
      sort: query.sort,
    });
    return apiSuccess({
      items: result.items.map(serializeQuestSummary),
      nextCursor: result.nextCursor ? encodeCursor(result.nextCursor) : null,
    });
  } catch (error) {
    if (error instanceof CursorInputError) {
      set.status = 400;
      return apiError(error.code, error.message);
    }
    throw error;
  }
};

export const getAdminQuestDetailController = async ({
  params,
  set,
}: AdminContext & { params: AdminQuestParams }): Promise<ApiResponse<AdminQuestDetailResponse>> => {
  const quest = await getAdminQuestDetail(params.questId);
  if (!quest) return questNotFound(set);

  return apiSuccess(serializeQuestDetail(quest));
};
