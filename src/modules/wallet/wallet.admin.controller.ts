import { AdminActionError } from '@/modules/admin';
import type { AdminContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';
import { CursorInputError } from '@/shared/cursor';

import { MoneyDomainError } from './wallet.money';
import { listWalletStatusHistory } from './wallet.status.service';
import { rebuildWalletProjection, verifyWalletProjection } from './wallet.service';
import type {
  AdminWalletParams,
  AdminWalletStatusChangeHeaders,
  AdminWalletStatusChangeInput,
} from './wallet.admin.schema';
import type { AdminWalletListQuery } from './wallet.admin.schema';
import {
  changeWalletStatusAdmin,
  getAdminWalletDetail,
  listAdminWallets,
  serializeWallet,
} from './wallet.admin.service';

type ExtendedAdminContext = AdminContext & {
  adminSession?: {
    admin?: { id: string; email?: string };
    user?: { id: string; email?: string };
  };
};

const mapMoneyDomainErrorStatus = (code: string): number => {
  if (code === 'WALLET_NOT_FOUND' || code === 'STUDENT_NOT_FOUND') {
    return 404;
  }
  if (
    code === 'INVALID_WALLET_STATUS' ||
    code === 'WALLET_STATUS_REASON_REQUIRED' ||
    code === 'INVALID_WALLET_STATUS_ACTOR' ||
    code === 'AMOUNT_OUT_OF_RANGE' ||
    code === 'INVALID_SATANG' ||
    code === 'INVALID_LIMIT'
  ) {
    return 400;
  }
  return 409;
};

const setAdminActionStatus = (set: ExtendedAdminContext['set'], code: string) => {
  set.status =
    code === 'ADMIN_ACTION_ADMIN_NOT_FOUND'
      ? 403
      : ['ADMIN_ACTION_KEY_REUSED', 'ADMIN_ACTION_CONFLICT', 'ADMIN_ACTION_WRITE_FAILED'].includes(
            code
          )
        ? 409
        : 400;
};

export const changeWalletStatusAdminController = async ({
  admin,
  adminSession,
  body,
  headers,
  params,
  set,
}: ExtendedAdminContext & {
  body: AdminWalletStatusChangeInput;
  headers: AdminWalletStatusChangeHeaders;
  params: AdminWalletParams;
}): Promise<ApiResponse> => {
  try {
    const actorAdminId = adminSession?.admin?.id ?? admin?.id ?? adminSession?.user?.id;
    if (!actorAdminId) {
      set.status = 403;
      return apiError('ADMIN_ACTION_ADMIN_NOT_FOUND', 'Admin authentication is required.');
    }

    const result = await changeWalletStatusAdmin({
      adminId: actorAdminId,
      walletId: params.walletId,
      toStatus: body.toStatus,
      reason: body.reason,
      requestKey: headers['idempotency-key'],
    });
    return apiSuccess({ wallet: result.resourceSummary.wallet });
  } catch (error) {
    if (error instanceof AdminActionError) {
      setAdminActionStatus(set, error.code);
      return apiError(error.code, error.message);
    }
    if (error instanceof MoneyDomainError) {
      set.status = mapMoneyDomainErrorStatus(error.code);
      return apiError(error.code, error.message);
    }
    throw error;
  }
};

export const listWalletStatusHistoryAdminController = async ({
  params,
  set,
}: AdminContext & {
  params: AdminWalletParams;
}): Promise<ApiResponse> => {
  try {
    const rawHistory = await listWalletStatusHistory(params.walletId);
    const history = rawHistory.map((entry) => ({
      id: entry.id,
      walletId: entry.walletId,
      fromStatus: entry.fromStatus,
      toStatus: entry.toStatus,
      reason: entry.reason ?? '',
      actorUserId: entry.actorUserId,
      actorAdminId: entry.actorAdminId,
      createdAt: entry.occurredAt.toISOString(),
    }));
    return apiSuccess({ history });
  } catch (error) {
    if (!(error instanceof MoneyDomainError)) throw error;
    set.status = mapMoneyDomainErrorStatus(error.code);
    return apiError(error.code, error.message);
  }
};

export const verifyWalletProjectionAdminController = async ({
  params,
  set,
}: AdminContext & {
  params: AdminWalletParams;
}): Promise<ApiResponse> => {
  try {
    const result = await verifyWalletProjection(params.walletId);
    return apiSuccess({
      matches: result.matches,
      projected: serializeWallet(result.projected),
      ledger: serializeWallet(result.ledger),
      activityCountMatches: result.activityCountMatches,
    });
  } catch (error) {
    if (!(error instanceof MoneyDomainError)) throw error;
    set.status = mapMoneyDomainErrorStatus(error.code);
    return apiError(error.code, error.message);
  }
};

export const rebuildWalletProjectionAdminController = async ({
  params,
  set,
}: AdminContext & {
  params: AdminWalletParams;
}): Promise<ApiResponse> => {
  try {
    const result = await rebuildWalletProjection(params.walletId);
    return apiSuccess({ wallet: serializeWallet(result) });
  } catch (error) {
    if (!(error instanceof MoneyDomainError)) throw error;
    set.status = mapMoneyDomainErrorStatus(error.code);
    return apiError(error.code, error.message);
  }
};

export const listAdminWalletsController = async ({
  query,
  set,
}: AdminContext & { query: AdminWalletListQuery }): Promise<ApiResponse> => {
  try {
    const data = await listAdminWallets(query);
    return apiSuccess(data);
  } catch (error) {
    if (!(error instanceof CursorInputError)) throw error;
    set.status = 400;
    return apiError(error.code, error.message);
  }
};

export const getAdminWalletDetailController = async ({
  params,
  set,
}: AdminContext & { params: AdminWalletParams }): Promise<ApiResponse> => {
  const wallet = await getAdminWalletDetail(params.walletId);
  if (!wallet) {
    set.status = 404;
    return apiError('WALLET_NOT_FOUND', 'Wallet was not found.');
  }
  return apiSuccess({ wallet });
};
