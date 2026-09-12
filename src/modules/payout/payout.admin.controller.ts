import { db } from '@/database/client';
import { paymentPayouts } from '@/database/schema/payment.schema';
import { AdminActionError } from '@/modules/admin';
import type { AdminContext } from '@/modules/auth';
import { ProviderEventError } from '@/modules/top-up/top-up.provider-event';
import { MoneyDomainError } from '@/modules/wallet';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';
import { readResourceVersion } from '@/shared/resource-version';
import { CursorInputError, decodeCursor, encodeCursor, parsePageLimit } from '@/shared/cursor';

import { eq } from 'drizzle-orm';
import type { Static } from 'elysia';

import {
  approvePayout,
  cancelPayout,
  getAdminPayout,
  listAdminPayoutStatusHistory,
  listAdminPayouts,
} from './payout.admin.service';
import { PayoutProviderError } from './payout.provider';
import {
  reconcilePayout,
  retryPayoutProviderEvent,
  type PayoutProviderEvent,
} from './payout.provider-event.service';
import type { Payout } from './payout.service';
import type {
  adminPayoutApprovalSchema,
  adminPayoutCancellationSchema,
  adminPayoutEventParamsSchema,
  adminPayoutListQuerySchema,
  adminPayoutParamsSchema,
} from './payout.admin.schema';

type AdminPayoutParams = Static<typeof adminPayoutParamsSchema>;
type AdminPayoutListQuery = Static<typeof adminPayoutListQuerySchema>;
type AdminPayoutApprovalInput = Static<typeof adminPayoutApprovalSchema>;
type AdminPayoutCancellationInput = Static<typeof adminPayoutCancellationSchema>;
type AdminPayoutEventParams = Static<typeof adminPayoutEventParamsSchema>;

const serializeReconciledPayout = (payout: Payout) => ({
  ...payout,
  createdAt: payout.createdAt.toISOString(),
  updatedAt: payout.updatedAt.toISOString(),
});

const serializePayoutProviderEvent = (event: PayoutProviderEvent) => ({
  ...event,
  providerOccurredAt: event.providerOccurredAt.toISOString(),
  rawPayloadExpiresAt: event.rawPayloadExpiresAt.toISOString(),
  claimedAt: event.claimedAt?.toISOString() ?? null,
  processedAt: event.processedAt?.toISOString() ?? null,
  receivedAt: event.receivedAt.toISOString(),
  createdAt: event.createdAt.toISOString(),
});

const serializePayout = (payout: Awaited<ReturnType<typeof getAdminPayout>>) => ({
  ...payout,
  createdAt: payout.createdAt.toISOString(),
  updatedAt: payout.updatedAt.toISOString(),
});

const serializeHistory = (history: Awaited<ReturnType<typeof listAdminPayoutStatusHistory>>) =>
  history.map((entry) => ({ ...entry, occurredAt: entry.occurredAt.toISOString() }));

const setAdminActionStatus = (set: AdminContext['set'], code: string) => {
  set.status = code === 'ADMIN_ACTION_ADMIN_NOT_FOUND'
    ? 403
    : ['ADMIN_ACTION_KEY_REUSED', 'ADMIN_ACTION_CONFLICT', 'ADMIN_ACTION_WRITE_FAILED'].includes(code)
      ? 409
      : 400;
};

const mapAdminError = (set: AdminContext['set'], error: unknown) => {
  if (error instanceof CursorInputError) {
    set.status = 400;
    return apiError(error.code, error.message);
  }
  if (error instanceof ProviderEventError) {
    if (error.code === 'PROVIDER_EVENT_NOT_FOUND') set.status = 404;
    else if (error.code === 'PROVIDER_EVENT_NOT_RETRYABLE' || error.code === 'PROVIDER_EVENT_CONFLICT') set.status = 409;
    else if (['PROVIDER_EVENT_KEY_UNAVAILABLE', 'PROVIDER_EVENT_KEY_VERSION_UNKNOWN', 'PROVIDER_EVENT_ENCRYPTION_FAILED'].includes(error.code)) set.status = 500;
    else set.status = 400;
    return apiError(error.code, error.message);
  }
  if (error instanceof PayoutProviderError) {
    set.status = 502;
    return apiError(error.code, error.message);
  }
  if (error instanceof MoneyDomainError) {
    const notFound = ['PAYOUT_NOT_FOUND', 'PAYOUT_QUOTE_NOT_FOUND', 'PAYOUT_DESTINATION_NOT_FOUND', 'MEMBER_NOT_FOUND', 'WALLET_NOT_FOUND'];
    const badRequest = ['INVALID_LIMIT', 'INVALID_AMOUNT', 'INVALID_CURSOR'];
    set.status = notFound.includes(error.code) ? 404 : badRequest.includes(error.code) ? 400 : 409;
    return apiError(error.code, error.message);
  }
  if (!(error instanceof Error) || !('code' in error)) throw error;
  const code = error.code as string;
  if (code === 'PAYOUT_NOT_FOUND') set.status = 404;
  else if (code.startsWith('ADMIN_ACTION_')) setAdminActionStatus(set, code);
  else if (code === 'IDEMPOTENCY_UNAVAILABLE') set.status = 503;
  else set.status = 409;
  return apiError(code, error.message);
};

const mapAdminCommandError = (set: AdminContext['set'], error: unknown) => {
  if (error instanceof AdminActionError) {
    setAdminActionStatus(set, error.code);
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

export const reconcilePayoutAdminController = async ({
  params,
  set,
}: AdminContext & { params: AdminPayoutParams }): Promise<ApiResponse> => {
  try {
    const [payout] = await db
      .select({ id: paymentPayouts.id, userId: paymentPayouts.userId })
      .from(paymentPayouts)
      .where(eq(paymentPayouts.id, params.payoutId))
      .limit(1);

    if (!payout) {
      set.status = 404;
      return apiError('PAYOUT_NOT_FOUND', 'Payout does not exist.');
    }

    const result = await reconcilePayout(payout.userId, params.payoutId);
    return apiSuccess({ payout: serializeReconciledPayout(result) });
  } catch (error) {
    return mapAdminError(set, error);
  }
};

export const retryPayoutEventAdminController = async ({
  params,
  set,
}: AdminContext & { params: AdminPayoutEventParams }): Promise<ApiResponse> => {
  try {
    const result = await retryPayoutProviderEvent(params.eventId);
    return apiSuccess({ event: serializePayoutProviderEvent(result) });
  } catch (error) {
    return mapAdminError(set, error);
  }
};
