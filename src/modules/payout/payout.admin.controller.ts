import type { AdminContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';
import { CursorInputError, decodeCursor, encodeCursor, parsePageLimit } from '@/shared/cursor';

import type { Static } from 'elysia';

import {
  approvePayout,
  getAdminPayout,
  listAdminPayoutStatusHistory,
  listAdminPayouts,
  rejectPayout,
} from './payout.admin.service';
import type {
  adminPayoutApprovalSchema,
  adminPayoutListQuerySchema,
  adminPayoutParamsSchema,
  adminPayoutRejectionSchema,
} from './payout.admin.schema';

type AdminPayoutParams = Static<typeof adminPayoutParamsSchema>;
type AdminPayoutListQuery = Static<typeof adminPayoutListQuerySchema>;
type AdminPayoutApprovalInput = Static<typeof adminPayoutApprovalSchema>;
type AdminPayoutRejectionInput = Static<typeof adminPayoutRejectionSchema>;

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
  else if (code === 'PAYOUT_REJECTION_REASON_REQUIRED') set.status = 400;
  else if (code === 'IDEMPOTENCY_UNAVAILABLE') set.status = 503;
  else set.status = 409;
  return apiError(code, error.message);
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
  try {
    await approvePayout(admin.id, params.payoutId, {
      idempotencyKey: request.headers.get('idempotency-key') ?? '',
      note: body.note,
    });
    return apiSuccess(serializePayout(await getAdminPayout(params.payoutId)));
  } catch (error) {
    return mapAdminError(set, error);
  }
};

export const rejectPayoutController = async ({
  body,
  params,
  request,
  admin,
  set,
}: AdminContext & { body: AdminPayoutRejectionInput; params: AdminPayoutParams; request: Request }): Promise<ApiResponse> => {
  try {
    await rejectPayout(admin.id, params.payoutId, {
      idempotencyKey: request.headers.get('idempotency-key') ?? '',
      reason: body.reason,
    });
    return apiSuccess(serializePayout(await getAdminPayout(params.payoutId)));
  } catch (error) {
    return mapAdminError(set, error);
  }
};
