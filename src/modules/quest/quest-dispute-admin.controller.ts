import { AdminActionError } from '@/modules/admin';
import type { AdminContext, AuthedContext } from '@/modules/auth';
import { MoneyDomainError } from '@/modules/wallet';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';
import { CursorInputError, decodeCursor, encodeCursor, parsePageLimit } from '@/shared/cursor';
import { readResourceVersion } from '@/shared/resource-version';

import type { Static } from 'elysia';

import {
  AdminDisputeCaseError,
  createAdminDisputeCase,
  getAdminDisputeCase,
  getAdminDisputeEvidence,
  listAdminDisputeCases,
  resolveAdminDisputeCase,
  summaryFromRecord,
} from './quest-dispute-admin.service';
import type {
  adminDisputeCommandResponseSchema,
  adminDisputeDetailResponseSchema,
  adminDisputeEvidenceResponseSchema,
  adminDisputeOpenBodySchema,
  adminDisputeOpenResponseSchema,
  adminDisputeOpenParamsSchema,
  adminDisputeListQuerySchema,
  adminDisputeListResponseSchema,
  adminDisputeParamsSchema,
  adminDisputeResolveBodySchema,
} from './quest-dispute-admin.schema';

type AdminDisputeParams = Static<typeof adminDisputeParamsSchema>;
type AdminDisputeListQuery = Static<typeof adminDisputeListQuerySchema>;
type AdminDisputeResolveBody = Static<typeof adminDisputeResolveBodySchema>;
type AdminDisputeListResponse = Static<typeof adminDisputeListResponseSchema>['data'];
type AdminDisputeDetailResponse = Static<typeof adminDisputeDetailResponseSchema>['data'];
type AdminDisputeEvidenceResponse = Static<typeof adminDisputeEvidenceResponseSchema>['data'];
type AdminDisputeCommandResponse = Static<typeof adminDisputeCommandResponseSchema>['data'];
type AdminDisputeOpenBody = Static<typeof adminDisputeOpenBodySchema>;
type AdminDisputeOpenParams = Static<typeof adminDisputeOpenParamsSchema>;
type AdminDisputeOpenResponse = Static<typeof adminDisputeOpenResponseSchema>['data'];

const mapAdminDisputeError = (set: AdminContext['set'], error: unknown): ApiResponse => {
  if (error instanceof CursorInputError) {
    set.status = 400;
    return apiError(error.code, error.message);
  }
  if (error instanceof AdminDisputeCaseError) {
    if (error.code === 'DISPUTE_CASE_NOT_FOUND') set.status = 404;
    else if (
      error.code === 'DISPUTE_CASE_OUTCOME_INVALID' ||
      error.code === 'DISPUTE_CASE_AMOUNT_REQUIRED'
    ) set.status = 400;
    else set.status = 409;
    return apiError(error.code, error.message);
  }
  if (error instanceof AdminActionError) {
    if (error.code === 'ADMIN_ACTION_ADMIN_NOT_FOUND') set.status = 403;
    else if (error.code === 'ADMIN_ACTION_INVALID_VERSION' || error.code === 'ADMIN_ACTION_REASON_REQUIRED' || error.code === 'ADMIN_ACTION_INVALID_REASON_CODE') set.status = 400;
    else if (
      error.code === 'ADMIN_ACTION_KEY_REUSED' ||
      error.code === 'ADMIN_ACTION_CONFLICT' ||
      error.code === 'ADMIN_ACTION_WRITE_FAILED'
    ) set.status = 409;
    else set.status = 400;
    return apiError(error.code, error.message);
  }
  if (error instanceof MoneyDomainError) {
    set.status = error.code === 'IDEMPOTENCY_UNAVAILABLE' ? 503 : 409;
    return apiError(error.code, error.message);
  }
  throw error;
};

export const listAdminDisputesController = async ({
  query,
  set,
}: AdminContext & { query: AdminDisputeListQuery }): Promise<ApiResponse<AdminDisputeListResponse>> => {
  try {
    const result = await listAdminDisputeCases({
      status: query.status,
      limit: parsePageLimit(query.limit),
      cursor: decodeCursor(query.cursor),
      sort: query.sort,
    });
    return apiSuccess({
      items: result.items,
      nextCursor: result.nextCursor ? encodeCursor(result.nextCursor) : null,
    });
  } catch (error) {
    return mapAdminDisputeError(set, error) as ApiResponse<AdminDisputeListResponse>;
  }
};

export const createAdminDisputeController = async ({
  body,
  params,
  admin,
  set,
}: AdminContext & {
  body: AdminDisputeOpenBody;
  params: AdminDisputeOpenParams;
}): Promise<ApiResponse<AdminDisputeOpenResponse>> => {
  try {
    const created = await createAdminDisputeCase({
      questId: params.questId,
      filerUserId: body.workerId,
      openedByAdminId: admin.id,
    });
    return apiSuccess(summaryFromRecord(created));
  } catch (error) {
    return mapAdminDisputeError(set, error) as ApiResponse<AdminDisputeOpenResponse>;
  }
};

export const fileAdminDisputeCaseController = async ({
  params,
  session,
  set,
}: AuthedContext & {
  params: AdminDisputeOpenParams;
}): Promise<ApiResponse<AdminDisputeOpenResponse>> => {
  try {
    const created = await createAdminDisputeCase({
      questId: params.questId,
      filerUserId: session.user.id,
    });
    return apiSuccess(summaryFromRecord(created));
  } catch (error) {
    return mapAdminDisputeError(set, error) as ApiResponse<AdminDisputeOpenResponse>;
  }
};

export const getAdminDisputeController = async ({
  params,
  set,
}: AdminContext & { params: AdminDisputeParams }): Promise<ApiResponse<AdminDisputeDetailResponse>> => {
  try {
    return apiSuccess(await getAdminDisputeCase(params.disputeCaseId));
  } catch (error) {
    return mapAdminDisputeError(set, error) as ApiResponse<AdminDisputeDetailResponse>;
  }
};

export const getAdminDisputeEvidenceController = async ({
  params,
  request,
  admin,
  set,
}: AdminContext & { params: AdminDisputeParams; request: Request }): Promise<ApiResponse<AdminDisputeEvidenceResponse>> => {
  try {
    return apiSuccess(await getAdminDisputeEvidence(
      admin.id,
      params.disputeCaseId,
      request.headers.get('idempotency-key') ?? '',
    ));
  } catch (error) {
    return mapAdminDisputeError(set, error) as ApiResponse<AdminDisputeEvidenceResponse>;
  }
};

export const resolveAdminDisputeController = async ({
  body,
  params,
  request,
  admin,
  set,
}: AdminContext & {
  body: AdminDisputeResolveBody;
  params: AdminDisputeParams;
  request: Request;
}): Promise<ApiResponse<AdminDisputeCommandResponse>> => {
  const revision = readResourceVersion(request);
  if (revision.invalid || revision.value === undefined) {
    set.status = 400;
    return apiError('ADMIN_ACTION_INVALID_VERSION', 'A current Dispute Case version is required.');
  }

  try {
    const result = await resolveAdminDisputeCase({
      adminId: admin.id,
      disputeCaseId: params.disputeCaseId,
      expectedVersion: revision.value,
      requestKey: request.headers.get('idempotency-key') ?? '',
      reasonCode: body.reasonCode,
      outcome: body.outcome,
      workerId: body.workerId,
      amountSatang: body.amountSatang,
    });
    if (result.resourceVersion === null) {
      set.status = 500;
      return apiError('ADMIN_ACTION_INVALID_RESULT', 'Admin Action did not return a Dispute Case version.');
    }
    return apiSuccess({
      resourceSummary: result.resourceSummary,
      resourceVersion: result.resourceVersion,
      adminActionId: result.adminActionId,
    });
  } catch (error) {
    return mapAdminDisputeError(set, error) as ApiResponse<AdminDisputeCommandResponse>;
  }
};
