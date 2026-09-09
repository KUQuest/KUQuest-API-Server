import { AdminActionError } from '@/modules/admin';
import type { AdminContext } from '@/modules/auth';
import { MoneyDomainError } from '@/modules/wallet';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';
import { readResourceVersion } from '@/shared/resource-version';
import { CursorInputError, decodeCursor, encodeCursor, parsePageLimit } from '@/shared/cursor';

import type { Static } from 'elysia';

import {
  approvePayout,
  cancelPayout,
  getAdminPayout,
  listAdminPayoutStatusHistory,
  listAdminPayouts,
} from './payout.admin.service';
import type {
  adminPayoutApprovalSchema,
  adminPayoutCancellationSchema,
  adminPayoutListQuerySchema,
  adminPayoutParamsSchema,
} from './payout.admin.schema';

type AdminPayoutParams = Static<typeof adminPayoutParamsSchema>;
type AdminPayoutListQuery = Static<typeof adminPayoutListQuerySchema>;
type AdminPayoutApprovalInput = Static<typeof adminPayoutApprovalSchema>;
type AdminPayoutCancellationInput = Static<typeof adminPayoutCancellationSchema>;

const serializePayout = (payout: Awaited<ReturnType<typeof getAdminPayout>>) => ({
  ...payout,
  createdAt: payout.createdAt.toISOString(),
  updatedAt: payout.updatedAt.toISOString(),
});

const serializeHistory = (history: Awaited<ReturnType<typeof listAdminPayoutStatusHistory>>) =>
  history.map((entry) => ({ ...entry, occurredAt: entry.occurredAt.toISOString() }));

const mapAdminError = (set: AdminContext['set'], error: unknown) => {
  if (error instanceof CursorInputError) {
    set.status = 400;
    return apiError(error.code, error.message);
  }
  if (!(error instanceof Error) || !('code' in error)) throw error;
  const code = error.code as string;
  if (code === 'PAYOUT_NOT_FOUND') set.status = 404;
  else if (code === 'ADMIN_ACTION_ADMIN_NOT_FOUND') set.status = 403;
  else if (code.startsWith('ADMIN_ACTION_') && !['ADMIN_ACTION_KEY_REUSED', 'ADMIN_ACTION_CONFLICT', 'ADMIN_ACTION_WRITE_FAILED'].includes(code)) set.status = 400;
  else if (code === 'IDEMPOTENCY_UNAVAILABLE') set.status = 503;
  else set.status = 409;
  return apiError(code, error.message);
};

const mapAdminCommandError = (set: AdminContext['set'], error: unknown) => {
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
    set.status = error.code === 'PAYOUT_NOT_FOUND' ? 404 : 409;
    return apiError(error.code, error.message);
  }
  throw error;
};

const runAdminPayoutCommand = async (
  set: AdminContext['set'],
  request: Request,
  adminId: string,
  payoutId: string,
  reasonCode: string,
  execute: (input: {
    adminId: string;
    payoutId: string;
    idempotencyKey: string;
    expectedVersion: number;
    reasonCode: string;
  }) => ReturnType<typeof approvePayout>,
): Promise<ApiResponse> => {
  const revision = readResourceVersion(request);
  if (revision.invalid || revision.value === undefined) {
    set.status = 400;
    return apiError('ADMIN_ACTION_INVALID_VERSION', 'A current Payout version is required.');
  }
  try {
    const result = await execute({
      adminId,
      payoutId,
      idempotencyKey: request.headers.get('idempotency-key') ?? '',
      expectedVersion: revision.value,
      reasonCode,
    });
    if (result.resourceVersion === null) {
      set.status = 500;
      return apiError('ADMIN_ACTION_INVALID_RESULT', 'Admin Action did not return a Payout version.');
    }
    return apiSuccess({
      resourceSummary: result.resourceSummary,
      resourceVersion: result.resourceVersion,
      adminActionId: result.adminActionId,
    });
  } catch (error) {
    return mapAdminCommandError(set, error);
  }
};

export const listAdminPayoutsController = async ({
  query,
  set,
}: AdminContext & { query: AdminPayoutListQuery }): Promise<ApiResponse> => {
  try {
    const result = await listAdminPayouts({
      status: query.status,
      limit: parsePageLimit(query.limit),
      cursor: decodeCursor(query.cursor),
      sort: query.sort,
    });
    return apiSuccess({
      items: result.items.map(serializePayout),
      nextCursor: result.nextCursor
        ? encodeCursor(result.nextCursor)
        : null,
    });
  } catch (error) {
    return mapAdminError(set, error);
  }
};

export const getAdminPayoutController = async ({
  params,
  set,
}: AdminContext & { params: AdminPayoutParams }): Promise<ApiResponse> => {
  try {
    const payout = await getAdminPayout(params.payoutId);
    const history = await listAdminPayoutStatusHistory(params.payoutId);
    return apiSuccess({ ...serializePayout(payout), history: serializeHistory(history) });
  } catch (error) {
    return mapAdminError(set, error);
  }
};

export const listAdminPayoutStatusHistoryController = async ({
  params,
  set,
}: AdminContext & { params: AdminPayoutParams }): Promise<ApiResponse> => {
  try {
    return apiSuccess(serializeHistory(await listAdminPayoutStatusHistory(params.payoutId)));
  } catch (error) {
    return mapAdminError(set, error);
  }
};

export const approvePayoutController = async ({
  body,
  params,
  request,
  admin,
  set,
}: AdminContext & { body: AdminPayoutApprovalInput; params: AdminPayoutParams; request: Request }): Promise<ApiResponse> => {
  return runAdminPayoutCommand(
    set,
    request,
    admin.id,
    params.payoutId,
    body.reasonCode,
    approvePayout,
  );
};

export const cancelPayoutController = async ({
  body,
  params,
  request,
  admin,
  set,
}: AdminContext & { body: AdminPayoutCancellationInput; params: AdminPayoutParams; request: Request }): Promise<ApiResponse> => runAdminPayoutCommand(
  set,
  request,
  admin.id,
  params.payoutId,
  body.reasonCode,
  cancelPayout,
);
