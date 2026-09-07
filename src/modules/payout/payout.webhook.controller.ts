import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';

import type { StatusMap } from 'elysia/utils';

import { ProviderEventError, receivePayoutProviderEvent } from './payout.provider-event.service';

type WebhookContext = {
  request: Request;
  set: { status?: number | keyof StatusMap };
};

const responseForProviderEventError = (
  set: WebhookContext['set'],
  error: ProviderEventError,
): ApiResponse => {
  if (error.code === 'PROVIDER_EVENT_AUTHENTICATION_FAILED') {
    set.status = 401;
    return apiError('UNAUTHORIZED', 'The Xendit webhook token is invalid.');
  }
  if (error.code === 'PROVIDER_EVENT_INVALID') {
    set.status = 400;
    return apiError('INVALID_WEBHOOK_PAYLOAD', 'The Xendit webhook payload is invalid.');
  }
  if (error.code === 'PROVIDER_EVENT_CONFLICT') {
    set.status = 409;
    return apiError('PROVIDER_EVENT_CONFLICT', 'The Provider event identifier was reused with a different payload.');
  }
  set.status = 500;
  return apiError('PROVIDER_EVENT_UNAVAILABLE', 'The Provider event could not be stored.');
};

export const receivePayoutWebhookController = async ({
  request,
  set,
}: WebhookContext): Promise<ApiResponse> => {
  try {
    await receivePayoutProviderEvent({
      rawPayload: await request.text(),
      providerEventId: request.headers.get('webhook-id') ?? undefined,
      callbackToken: request.headers.get('x-callback-token') ?? undefined,
    });
    set.status = 202;
    return apiSuccess();
  } catch (error: unknown) {
    if (error instanceof ProviderEventError) return responseForProviderEventError(set, error);
    throw error;
  }
};
