import type { AuthedContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';

import type { Static } from 'elysia';

import {
  getPayoutDestination,
  retirePayoutDestination,
  savePayoutDestination,
  PayoutDestinationError,
  type PayoutDestination,
} from './payout-destination.service';
import type { payoutDestinationCreateSchema } from './payout-destination.schema';
import { PayoutDestinationEncryptionError } from './payout-destination.crypto';

type PayoutDestinationCreateInput = Static<typeof payoutDestinationCreateSchema>;

const serializePayoutDestination = (destination: PayoutDestination) => ({
  ...destination,
  createdAt: destination.createdAt.toISOString(),
  retiredAt: destination.retiredAt?.toISOString() ?? null,
});

const mapPayoutDestinationError = (set: AuthedContext['set'], error: unknown) => {
  if (error instanceof PayoutDestinationEncryptionError) {
    set.status = 503;
    return apiError(error.code, error.message);
  }
  if (error instanceof PayoutDestinationError) {
    if (error.code === 'PAYOUT_DESTINATION_MEMBER_NOT_FOUND') {
      set.status = 404;
      return apiError(error.code, error.message);
    }
    if (error.code === 'PAYOUT_DESTINATION_INVALID') {
      set.status = 400;
      return apiError(error.code, error.message);
    }
    set.status = 500;
    return apiError(error.code, error.message);
  }
  throw error;
};

export const getPayoutDestinationController = async ({
  session,
  set,
}: AuthedContext): Promise<ApiResponse> => {
  try {
    const destination = await getPayoutDestination(session.user.id);
    return apiSuccess(destination ? serializePayoutDestination(destination) : null);
  } catch (error) {
    return mapPayoutDestinationError(set, error);
  }
};

export const savePayoutDestinationController = async ({
  body,
  session,
  set,
}: AuthedContext & { body: PayoutDestinationCreateInput }): Promise<ApiResponse> => {
  try {
    const destination = await savePayoutDestination({
      principalUserId: session.user.id,
      givenName: body.givenName,
      surname: body.surname,
      accountHolderName: body.accountHolderName,
      bankCode: body.bankCode,
      accountNumber: body.accountNumber,
      accountCountry: body.accountCountry ?? 'TH',
      accountCurrency: body.accountCurrency ?? 'THB',
      recipientType: body.recipientType ?? 'SELF',
      relationship: body.relationship ?? 'SELF',
      routingType: body.routingType ?? 'BANK_ACCOUNT',
      routingValue: body.routingValue ?? body.accountNumber,
    });
    return apiSuccess(serializePayoutDestination(destination));
  } catch (error) {
    return mapPayoutDestinationError(set, error);
  }
};

export const retirePayoutDestinationController = async ({
  session,
  set,
}: AuthedContext): Promise<ApiResponse> => {
  try {
    const retired = await retirePayoutDestination(session.user.id);
    if (!retired) {
      set.status = 404;
      return apiError('PAYOUT_DESTINATION_NOT_FOUND', 'Active Payout Destination not found.');
    }
    return apiSuccess({ retired: true as const });
  } catch (error) {
    return mapPayoutDestinationError(set, error);
  }
};
