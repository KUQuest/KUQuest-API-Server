import { AdminActionError } from '@/modules/admin';
import type { AdminContext } from '@/modules/auth';
import { MoneyDomainError } from '@/modules/wallet';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';
import { readResourceVersion } from '@/shared/resource-version';
import { CursorInputError, decodeCursor, encodeCursor, parsePageLimit } from '@/shared/cursor';

import type { Static } from 'elysia';

import { WorkChatTransitionError } from './quest-assignment.service';
import {
  hideQuest,
  QuestAdminCommandError,
  restoreQuest,
  terminateQuest,
} from './quest-admin.command.service';
import {
  getAdminQuestDetail,
  listAdminQuests,
  serializeAdminQuestSummary,
} from './quest-admin.service';
import type {
  AdminQuestDetail,
  AdminQuestEditHistoryEntry,
} from './quest-admin.service';
import type {
  QuestAdminCommandInput,
  QuestAdminCommandResult,
} from './quest-admin.command.service';
import type {
  adminQuestCommandResponseSchema,
  adminQuestDetailResponseSchema,
  adminQuestHideBodySchema,
  adminQuestListQuerySchema,
  adminQuestListResponseSchema,
  adminQuestParamsSchema,
  adminQuestRestoreBodySchema,
  adminQuestTerminateBodySchema,
} from './quest-admin.schema';

type AdminQuestParams = Static<typeof adminQuestParamsSchema>;
type AdminQuestListQuery = Static<typeof adminQuestListQuerySchema>;
type AdminQuestListResponse = Static<typeof adminQuestListResponseSchema>['data'];
type AdminQuestDetailResponse = Static<typeof adminQuestDetailResponseSchema>['data'];
type AdminQuestCommandResponse = Static<typeof adminQuestCommandResponseSchema>['data'];
type AdminQuestHideBody = Static<typeof adminQuestHideBodySchema>;
type AdminQuestRestoreBody = Static<typeof adminQuestRestoreBodySchema>;
type AdminQuestTerminateBody = Static<typeof adminQuestTerminateBodySchema>;

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

const serializeQuestDetail = (quest: AdminQuestDetail): AdminQuestDetailResponse => ({
  ...quest,
  ...serializeAdminQuestSummary(quest),
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
      items: result.items.map(serializeAdminQuestSummary),
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
const mapQuestAdminCommandError = (
  set: AdminContext['set'],
  error: unknown,
): ApiResponse<AdminQuestCommandResponse> => {
  if (error instanceof QuestAdminCommandError) {
    set.status = error.code === 'QUEST_NOT_FOUND' ? 404 : 409;
    return apiError(error.code, error.message);
  }
  if (error instanceof AdminActionError) {
    if (error.code === 'ADMIN_ACTION_ADMIN_NOT_FOUND') set.status = 403;
    else if (
      error.code === 'ADMIN_ACTION_KEY_REUSED' ||
      error.code === 'ADMIN_ACTION_CONFLICT' ||
      error.code === 'ADMIN_ACTION_WRITE_FAILED'
    ) set.status = 409;
    else set.status = 400;
    return apiError(error.code, error.message);
  }
  if (error instanceof MoneyDomainError) {
    set.status = 409;
    return apiError(error.code, error.message);
  }
  if (error instanceof WorkChatTransitionError) {
    set.status = 503;
    return apiError('WORK_CHAT_TRANSITION_FAILED', error.message);
  }
  throw error;
};

const runQuestAdminCommand = async (
  set: AdminContext['set'],
  request: Request,
  adminId: string,
  questId: string,
  reasonCode: string | undefined,
  execute: (input: QuestAdminCommandInput) => Promise<QuestAdminCommandResult>,
): Promise<ApiResponse<AdminQuestCommandResponse>> => {
  const revision = readResourceVersion(request);
  if (revision.invalid || revision.value === undefined) {
    set.status = 400;
    return apiError('ADMIN_ACTION_INVALID_VERSION', 'A current Quest version is required.');
  }

  try {
    const result = await execute({
      adminId,
      questId,
      expectedVersion: revision.value,
      requestKey: request.headers.get('idempotency-key') ?? '',
      reasonCode,
    });
    if (result.resourceVersion === null) {
      set.status = 500;
      return apiError('ADMIN_ACTION_INVALID_RESULT', 'Admin Action did not return a Quest version.');
    }
    return apiSuccess({
      resourceSummary: result.resourceSummary,
      resourceVersion: result.resourceVersion,
      adminActionId: result.adminActionId,
    });
  } catch (error) {
    return mapQuestAdminCommandError(set, error);
  }
};

export const hideAdminQuestController = async ({
  body,
  params,
  request,
  admin,
  set,
}: AdminContext & {
  body: AdminQuestHideBody;
  params: AdminQuestParams;
  request: Request;
}): Promise<ApiResponse<AdminQuestCommandResponse>> => runQuestAdminCommand(
  set,
  request,
  admin.id,
  params.questId,
  body.reasonCode,
  hideQuest,
);

export const restoreAdminQuestController = async ({
  body,
  params,
  request,
  admin,
  set,
}: AdminContext & {
  body: AdminQuestRestoreBody;
  params: AdminQuestParams;
  request: Request;
}): Promise<ApiResponse<AdminQuestCommandResponse>> => runQuestAdminCommand(
  set,
  request,
  admin.id,
  params.questId,
  body.reasonCode,
  restoreQuest,
);

export const terminateAdminQuestController = async ({
  body,
  params,
  request,
  admin,
  set,
}: AdminContext & {
  body: AdminQuestTerminateBody;
  params: AdminQuestParams;
  request: Request;
}): Promise<ApiResponse<AdminQuestCommandResponse>> => runQuestAdminCommand(
  set,
  request,
  admin.id,
  params.questId,
  body.reasonCode,
  terminateQuest,
);
