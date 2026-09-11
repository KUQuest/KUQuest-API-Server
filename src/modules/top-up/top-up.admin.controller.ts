import { db } from '@/database/client';
import { paymentTopUps } from '@/database/schema/payment.schema';
import type { AdminContext } from '@/modules/auth';
import { MoneyDomainError } from '@/modules/wallet';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';

import { eq } from 'drizzle-orm';
import type { Static } from 'elysia';
import QRCode from 'qrcode';

import { InboundPaymentProviderError } from './top-up.provider';
import { ProviderEventError } from './top-up.provider-event';
import {
  reconcileTopUp,
  retryTopUpProviderEvent,
  type TopUpProviderEvent,
} from './top-up.provider-event.service';
import type { TopUp } from './top-up.service';
import type {
  adminTopUpEventParamsSchema,
  adminTopUpParamsSchema,
} from './top-up.admin.schema';

type AdminTopUpParams = Static<typeof adminTopUpParamsSchema>;
type AdminTopUpEventParams = Static<typeof adminTopUpEventParamsSchema>;

const qrDataUrlFor = async (payload: string | null): Promise<string | null> => (
  payload
    ? QRCode.toDataURL(payload, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 360,
    })
    : null
);

export const serializeTopUp = async (topUp: TopUp) => ({
  ...topUp,
  qrDataUrl: await qrDataUrlFor(topUp.qrPayload),
  qrExpiresAt: topUp.qrExpiresAt?.toISOString() ?? null,
  createdAt: topUp.createdAt.toISOString(),
  updatedAt: topUp.updatedAt.toISOString(),
});

const serializeTopUpProviderEvent = (event: TopUpProviderEvent) => ({
  ...event,
  providerOccurredAt: event.providerOccurredAt.toISOString(),
  rawPayloadExpiresAt: event.rawPayloadExpiresAt.toISOString(),
  claimedAt: event.claimedAt?.toISOString() ?? null,
  processedAt: event.processedAt?.toISOString() ?? null,
  receivedAt: event.receivedAt.toISOString(),
  createdAt: event.createdAt.toISOString(),
});

const mapAdminTopUpError = (set: AdminContext['set'], error: unknown) => {
  if (error instanceof ProviderEventError) {
    if (error.code === 'PROVIDER_EVENT_NOT_FOUND') set.status = 404;
    else if (error.code === 'PROVIDER_EVENT_NOT_RETRYABLE' || error.code === 'PROVIDER_EVENT_CONFLICT') set.status = 409;
    else if (['PROVIDER_EVENT_KEY_UNAVAILABLE', 'PROVIDER_EVENT_KEY_VERSION_UNKNOWN', 'PROVIDER_EVENT_ENCRYPTION_FAILED'].includes(error.code)) set.status = 500;
    else set.status = 400;
    return apiError(error.code, error.message);
  }
  if (error instanceof MoneyDomainError) {
    const notFound = ['TOP_UP_NOT_FOUND', 'TOP_UP_QUOTE_NOT_FOUND', 'MEMBER_NOT_FOUND', 'WALLET_NOT_FOUND'];
    const badRequest = ['INVALID_LIMIT', 'INVALID_AMOUNT', 'INVALID_CURSOR'];
    set.status = notFound.includes(error.code) ? 404 : badRequest.includes(error.code) ? 400 : 409;
    return apiError(error.code, error.message);
  }
  if (error instanceof InboundPaymentProviderError) {
    set.status = 502;
    return apiError(error.code, error.message);
  }
  throw error;
};

export const reconcileTopUpAdminController = async ({
  params,
  set,
}: AdminContext & { params: AdminTopUpParams }): Promise<ApiResponse> => {
  try {
    const [topUp] = await db
      .select({ id: paymentTopUps.id, userId: paymentTopUps.userId })
      .from(paymentTopUps)
      .where(eq(paymentTopUps.id, params.topUpId))
      .limit(1);

    if (!topUp) {
      set.status = 404;
      return apiError('TOP_UP_NOT_FOUND', 'Top-up does not exist.');
    }

    const result = await reconcileTopUp(topUp.userId, params.topUpId);
    return apiSuccess({ topUp: await serializeTopUp(result) });
  } catch (error) {
    return mapAdminTopUpError(set, error);
  }
};

export const retryTopUpEventAdminController = async ({
  params,
  set,
}: AdminContext & { params: AdminTopUpEventParams }): Promise<ApiResponse> => {
  try {
    const result = await retryTopUpProviderEvent(params.eventId);
    return apiSuccess({ event: serializeTopUpProviderEvent(result) });
  } catch (error) {
    return mapAdminTopUpError(set, error);
  }
};
