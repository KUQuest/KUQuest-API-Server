import type { AuthedContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';

import type { Static } from 'elysia';

import {
  convertEarnings,
  ensureWallet,
  getWalletActivities,
} from './wallet.service';
import { MoneyDomainError, positiveSatang, type Satang } from './wallet.money';
import type {
  earningsConversionCreateSchema,
  earningsConversionHeadersSchema,
  walletActivitiesQuerySchema,
} from './wallet.schema';

type EarningsConversionCreateInput = Static<typeof earningsConversionCreateSchema>;
type EarningsConversionHeaders = Static<typeof earningsConversionHeadersSchema>;
type WalletActivitiesQuery = Static<typeof walletActivitiesQuerySchema>;

type WalletBalances = {
  spendingBalanceSatang: Satang;
  earningsBalanceSatang: Satang;
  fundingReservedSatang: Satang;
  reservedForPayoutsSatang: Satang;
};

const serializeWallet = (wallet: WalletBalances) => ({
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

export const convertEarningsController = async ({
  body,
  headers,
  session,
  set,
}: AuthedContext & {
  body: EarningsConversionCreateInput;
  headers: EarningsConversionHeaders;
}): Promise<ApiResponse> => {
  try {
    const conversion = await convertEarnings({
      principalUserId: session.user.id,
      amountSatang: positiveSatang(body.amountSatang),
      idempotency: { key: headers['idempotency-key'] },
    });
    return apiSuccess({
      id: conversion.id,
      principalUserId: conversion.principalUserId,
      amountSatang: conversion.amountSatang,
      businessReference: conversion.businessReference,
      ledgerTransactionId: conversion.ledgerTransactionId,
      createdAt: conversion.createdAt.toISOString(),
    });
  } catch (error) {
    if (!(error instanceof MoneyDomainError)) throw error;
    if (error.code === 'STUDENT_NOT_FOUND' || error.code === 'WALLET_NOT_FOUND') {
      set.status = 404;
    } else if (error.code === 'INVALID_SATANG' || error.code === 'AMOUNT_OUT_OF_RANGE') {
      set.status = 400;
    } else {
      set.status = 409;
    }
    return apiError(error.code, error.message);
  }
};

export const getWalletActivitiesController = async ({
  query,
  session,
  set,
}: AuthedContext & {
  query: WalletActivitiesQuery;
}): Promise<ApiResponse> => {
  try {
    const activities = await getWalletActivities(session.user.id, query?.limit ?? 50);
    return apiSuccess({
      activities: activities.map((activity) => ({
        id: activity.id,
        userId: activity.userId,
        ledgerTransactionId: activity.ledgerTransactionId,
        occurredAt: activity.occurredAt.toISOString(),
        type: activity.type,
        activityStatus: activity.activityStatus,
        spendingDeltaSatang: activity.spendingDeltaSatang,
        earningsDeltaSatang: activity.earningsDeltaSatang,
        fundingReservedDeltaSatang: activity.fundingReservedDeltaSatang,
        payoutReservedDeltaSatang: activity.payoutReservedDeltaSatang,
        resourceType: activity.resourceType,
        resourceId: activity.resourceId,
      })),
    });
  } catch (error) {
    if (!(error instanceof MoneyDomainError)) throw error;
    set.status = error.code === 'INVALID_LIMIT' ? 400 : 409;
    return apiError(error.code, error.message);
  }
};
