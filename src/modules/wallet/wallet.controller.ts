import type { AuthedContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';

import { ensureWallet } from './wallet.service';
import { MoneyDomainError } from './wallet.money';

const serializeWallet = (wallet: Awaited<ReturnType<typeof ensureWallet>>) => ({
  spendingBalanceSatang: wallet.spendingBalanceSatang,
  earningsBalanceSatang: wallet.earningsBalanceSatang,
  fundingReservedSatang: wallet.fundingReservedSatang,
  reservedForPayoutsSatang: wallet.reservedForPayoutsSatang,
});

export const getOwnWallet = async ({
  session,
  set,
}: AuthedContext): Promise<ApiResponse> => {
  try {
    return apiSuccess({ wallet: serializeWallet(await ensureWallet(session.user.id)) });
  } catch (error) {
    if (!(error instanceof MoneyDomainError)) throw error;

    set.status = error.code === 'STUDENT_NOT_FOUND' ? 404 : 409;
    return apiError(error.code, error.message);
  }
};
