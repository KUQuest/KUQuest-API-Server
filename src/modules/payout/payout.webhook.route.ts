import { apiSuccessSchema, responses } from '@/shared/api-response.schema';
import { API_V1_PREFIX } from '@/shared/api-version';

import { Elysia } from 'elysia';

import { receivePayoutWebhookController } from './payout.webhook.controller';

export const payoutWebhookRoute = new Elysia({
  name: 'payout-webhook-route',
  prefix: `${API_V1_PREFIX}/webhooks/xendit`,
}).post('/payouts', receivePayoutWebhookController, {
  response: responses(apiSuccessSchema, 400, 401, 409, 500, { successStatus: 202 }),
  detail: {
    tags: ['Xendit webhooks'],
    summary: 'Durably receive Xendit Payout events',
    description: 'Authenticates and stores a Xendit Payout event before acknowledging it. Financial effects are applied by a callable worker.',
    operationId: 'receiveXenditPayoutWebhook',
    security: [{ xenditWebhookAuth: [] }],
  },
});
