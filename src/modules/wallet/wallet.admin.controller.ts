import type { AdminContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';

import { MoneyDomainError } from './wallet.money';
import { changeWalletStatus, listWalletStatusHistory } from './wallet.status.service';
import { rebuildWalletProjection, verifyWalletProjection } from './wallet.service';
import type {
  AdminWalletParams,
  AdminWalletStatusChangeHeaders,
  AdminWalletStatusChangeInput,
} from './wallet.admin.schema';

type WalletBalances = {
  spendingBalanceSatang: number;
  earningsBalanceSatang: number;
  fundingReservedSatang: number;
  reservedForPayoutsSatang: number;
  walletStatus?: string;
};

type ExtendedAdminContext = AdminContext & {
  adminSession?: {
    admin?: { id: string; email?: string };
    user?: { id: string; email?: string };
  };
};

const serializeWallet = (
  wallet: WalletBalances | { wallet: WalletBalances },
): WalletBalances & { walletStatus: string } => {
  const target = 'wallet' in wallet && wallet.wallet ? wallet.wallet : (wallet as WalletBalances);
  return {
    spendingBalanceSatang: target.spendingBalanceSatang,
    earningsBalanceSatang: target.earningsBalanceSatang,
    fundingReservedSatang: target.fundingReservedSatang,
    reservedForPayoutsSatang: target.reservedForPayoutsSatang,
    walletStatus: target.walletStatus ?? 'ACTIVE',
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

export const changeWalletStatusAdminController = async ({
  admin,
  adminSession,
  body,
  headers: _headers,
  params,
  set,
}: ExtendedAdminContext & {
  body: AdminWalletStatusChangeInput;
  headers: AdminWalletStatusChangeHeaders;
  params: AdminWalletParams;
}): Promise<ApiResponse> => {
  try {
    const actorAdminId =
      adminSession?.admin?.id ??
      admin?.id ??
      adminSession?.user?.id;

    const { wallet: updatedWallet } = await changeWalletStatus({
      walletId: params.walletId,
      toStatus: body.toStatus,
      reason: body.reason,
      actorAdminId,
    });
    return apiSuccess({ wallet: serializeWallet(updatedWallet) });
  } catch (error) {
    if (!(error instanceof MoneyDomainError)) throw error;
    set.status = mapMoneyDomainErrorStatus(error.code);
    return apiError(error.code, error.message);
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
