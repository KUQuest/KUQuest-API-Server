import type { AuthedContext } from '@/modules/auth';
import { MoneyDomainError, positiveSatang } from '@/modules/wallet';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';

import type { Static } from 'elysia';
import QRCode from 'qrcode';

import {
  getTopUp,
  initiateTopUp,
  listTopUpStatusHistory,
  listTopUps,
  quoteTopUp,
} from './top-up.service';
import { InboundPaymentProviderError } from './top-up.provider';
import { ProviderEventError } from './top-up.provider-event';
import { simulateTopUpPayment, TopUpTestModeError } from './top-up.test-mode.service';
import type {
  topUpCreateSchema,
  topUpListQuerySchema,
  topUpParamsSchema,
  topUpQuoteCreateSchema,
} from './top-up.schema';

type TopUpCreateInput = Static<typeof topUpCreateSchema>;
type TopUpListQuery = Static<typeof topUpListQuerySchema>;
type TopUpParams = Static<typeof topUpParamsSchema>;
type TopUpQuoteCreateInput = Static<typeof topUpQuoteCreateSchema>;

const serializeDate = (value: Date | null) => value?.toISOString() ?? null;

const qrDataUrlFor = async (payload: string | null): Promise<string | null> => (
  payload
    ? QRCode.toDataURL(payload, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 360,
    })
    : null
);

const serializeTopUp = async (topUp: Awaited<ReturnType<typeof getTopUp>>) => ({
  ...topUp,
  qrDataUrl: await qrDataUrlFor(topUp.qrPayload),
  qrExpiresAt: serializeDate(topUp.qrExpiresAt),
  createdAt: topUp.createdAt.toISOString(),
  updatedAt: topUp.updatedAt.toISOString(),
});

const serializeQuote = (quote: Awaited<ReturnType<typeof quoteTopUp>>) => ({
  ...quote,
  expiresAt: quote.expiresAt.toISOString(),
  consumedAt: serializeDate(quote.consumedAt),
  createdAt: quote.createdAt.toISOString(),
});

const mapFinanceError = (set: AuthedContext['set'], error: unknown) => {
  if (error instanceof TopUpTestModeError) {
    set.status = 502;
    return apiError(error.code, error.message);
  }
  if (error instanceof ProviderEventError) {
    set.status = 502;
    return apiError(error.code, error.message);
  }
  if (error instanceof InboundPaymentProviderError) {
    set.status = 502;
    return apiError(error.code, error.message);
  }
  if (error instanceof MoneyDomainError) {
    const notFound = ['TOP_UP_NOT_FOUND', 'TOP_UP_QUOTE_NOT_FOUND', 'MEMBER_NOT_FOUND'];
    set.status = notFound.includes(error.code) ? 404 : error.code === 'INVALID_LIMIT' ? 400 : 409;
    return apiError(error.code, error.message);
  }
  throw error;
};

export const createTopUpQuoteController = async ({
  body,
  session,
  set,
}: AuthedContext & { body: TopUpQuoteCreateInput }): Promise<ApiResponse> => {
  try {
    return apiSuccess(serializeQuote(await quoteTopUp({
      principalUserId: session.user.id,
      creditSatang: positiveSatang(body.creditSatang),
    })));
  } catch (error) {
    return mapFinanceError(set, error);
  }
};

export const createTopUpController = async ({
  body,
  request,
  session,
  set,
}: AuthedContext & { body: TopUpCreateInput }): Promise<ApiResponse> => {
  try {
    const key = request?.headers.get('idempotency-key') ?? '';
    let topUp = await initiateTopUp({
      principalUserId: session.user.id,
      quoteId: body.quoteId,
      idempotency: { key },
    });
    const simulation = body.simulate
      ? await simulateTopUpPayment(session.user.id, topUp.id)
      : undefined;
    if (simulation) topUp = simulation.topUp;
    return apiSuccess({
      ...(await serializeTopUp(topUp)),
      ...(simulation ? {
        simulated: true,
        callbackReceived: simulation.callbackReceived,
        reconciliationUsed: simulation.reconciliationUsed,
      } : {}),
    });
  } catch (error) {
    return mapFinanceError(set, error);
  }
};

export const listTopUpsController = async ({
  query,
  session,
  set,
}: AuthedContext & { query: TopUpListQuery }): Promise<ApiResponse> => {
  try {
    return apiSuccess({
      items: await Promise.all((await listTopUps(session.user.id, query.limit)).map(serializeTopUp)),
      nextCursor: null,
    });
  } catch (error) {
    return mapFinanceError(set, error);
  }
};

export const getTopUpController = async ({
  params,
  session,
  set,
}: AuthedContext & { params: TopUpParams }): Promise<ApiResponse> => {
  try {
    return apiSuccess(await serializeTopUp(await getTopUp(session.user.id, params.topUpId)));
  } catch (error) {
    return mapFinanceError(set, error);
  }
};

export const listTopUpStatusHistoryController = async ({
  params,
  session,
  set,
}: AuthedContext & { params: TopUpParams }): Promise<ApiResponse> => {
  try {
    const history = await listTopUpStatusHistory(session.user.id, params.topUpId);
    return apiSuccess(history.map((entry) => ({
      ...entry,
      occurredAt: entry.occurredAt.toISOString(),
    })));
  } catch (error) {
    return mapFinanceError(set, error);
  }
};
