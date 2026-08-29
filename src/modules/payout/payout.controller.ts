import type { AuthedContext } from '@/modules/auth';
import { MoneyDomainError, positiveSatang } from '@/modules/wallet';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';

import type { Static } from 'elysia';

import {
  getPayout,
  initiatePayout,
  listPayoutStatusHistory,
  listPayouts,
  quotePayout,
} from './payout.service';
import type {
  payoutCreateSchema,
  payoutListQuerySchema,
  payoutParamsSchema,
  payoutQuoteCreateSchema,
} from './payout.schema';

type PayoutCreateInput = Static<typeof payoutCreateSchema>;
type PayoutListQuery = Static<typeof payoutListQuerySchema>;
type PayoutParams = Static<typeof payoutParamsSchema>;
type PayoutQuoteCreateInput = Static<typeof payoutQuoteCreateSchema>;

const serializeDate = (value: Date | null) => value?.toISOString() ?? null;

const serializePayout = (payout: Awaited<ReturnType<typeof getPayout>>) => ({
  ...payout,
  providerAmountSatang: payout.providerAmountSatang,
  actualFeeSatang: payout.actualFeeSatang,
  actualTaxSatang: payout.actualTaxSatang,
  actualDebitSatang: payout.actualDebitSatang,
  createdAt: payout.createdAt.toISOString(),
  updatedAt: payout.updatedAt.toISOString(),
});

const serializeQuote = (quote: Awaited<ReturnType<typeof quotePayout>>) => ({
  ...quote,
  expiresAt: quote.expiresAt.toISOString(),
  consumedAt: serializeDate(quote.consumedAt),
  createdAt: quote.createdAt.toISOString(),
});

const mapMoneyError = (set: AuthedContext['set'], error: unknown) => {
  if (!(error instanceof MoneyDomainError)) throw error;
  const notFound = ['PAYOUT_NOT_FOUND', 'PAYOUT_QUOTE_NOT_FOUND', 'PAYOUT_DESTINATION_NOT_FOUND', 'MEMBER_NOT_FOUND'];
  set.status = notFound.includes(error.code) ? 404 : 409;
  return apiError(error.code, error.message);
};

export const createPayoutQuoteController = async ({
  body,
  session,
  set,
}: AuthedContext & { body: PayoutQuoteCreateInput }): Promise<ApiResponse> => {
  try {
    return apiSuccess(serializeQuote(await quotePayout({
      principalUserId: session.user.id,
      receiptSatang: positiveSatang(body.receiptSatang),
    })));
  } catch (error) {
    return mapMoneyError(set, error);
  }
};

export const createPayoutController = async ({
  body,
  request,
  session,
  set,
}: AuthedContext & { body: PayoutCreateInput }): Promise<ApiResponse> => {
  try {
    const key = request?.headers.get('idempotency-key') ?? '';
    return apiSuccess(serializePayout(await initiatePayout({
      principalUserId: session.user.id,
      quoteId: body.quoteId,
      idempotency: { key },
    })));
  } catch (error) {
    return mapMoneyError(set, error);
  }
};

export const listPayoutsController = async ({
  query,
  session,
  set,
}: AuthedContext & { query: PayoutListQuery }): Promise<ApiResponse> => {
  try {
    return apiSuccess({
      items: (await listPayouts(session.user.id, query.limit)).map(serializePayout),
      nextCursor: null,
    });
  } catch (error) {
    return mapMoneyError(set, error);
  }
};

export const getPayoutController = async ({
  params,
  session,
  set,
}: AuthedContext & { params: PayoutParams }): Promise<ApiResponse> => {
  try {
    return apiSuccess(serializePayout(await getPayout(session.user.id, params.payoutId)));
  } catch (error) {
    return mapMoneyError(set, error);
  }
};

export const listPayoutStatusHistoryController = async ({
  params,
  session,
  set,
}: AuthedContext & { params: PayoutParams }): Promise<ApiResponse> => {
  try {
    const history = await listPayoutStatusHistory(session.user.id, params.payoutId);
    return apiSuccess(history.map((entry) => ({
      ...entry,
      occurredAt: entry.occurredAt.toISOString(),
    })));
  } catch (error) {
    return mapMoneyError(set, error);
  }
};
