import { authGuard } from '@/modules/auth';
import { API_V1_PREFIX } from '@/shared/api-version';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';

import { Elysia } from 'elysia';

import {
  getPayoutDestinationController,
  retirePayoutDestinationController,
  savePayoutDestinationController,
} from './payout-destination.controller';
import {
  payoutDestinationCreateSchema,
  payoutDestinationResponseSchema,
  payoutDestinationRetireResponseSchema,
} from './payout-destination.schema';

export const payoutDestinationRoute = new Elysia({
  name: 'payout-destination-route',
  prefix: `${API_V1_PREFIX}/payout-destinations`,
})
  .use(authGuard)
  .get('', getPayoutDestinationController, {
    response: responses(payoutDestinationResponseSchema, 401),
    detail: {
      tags: ['Payout Destinations'],
      summary: 'Get active Payout Destination',
      description: 'Returns the authenticated Student active Thai bank account destination with masked account number.',
      operationId: 'getActivePayoutDestination',
      security: betterAuthSecurity,
    },
  })
  .post('', savePayoutDestinationController, {
    body: payoutDestinationCreateSchema,
    response: responses(payoutDestinationResponseSchema, 400, 401, 404, 500),
    detail: {
      tags: ['Payout Destinations'],
      summary: 'Save active Payout Destination',
      description: 'Saves or replaces the active Thai bank account destination for the authenticated Student with application-layer encryption.',
      operationId: 'saveActivePayoutDestination',
      security: betterAuthSecurity,
    },
  })
  .delete('', retirePayoutDestinationController, {
    response: responses(payoutDestinationRetireResponseSchema, 401, 404, 500),
    detail: {
      tags: ['Payout Destinations'],
      summary: 'Retire active Payout Destination',
      description: 'Retires the active Thai bank account destination for the authenticated Student.',
      operationId: 'retireActivePayoutDestination',
      security: betterAuthSecurity,
    },
  });
