import { apiSuccessSchema, responses } from '@/shared/api-response.schema';
import { API_V1_PREFIX } from '@/shared/api-version';

import { Elysia } from 'elysia';

import { receiveTopUpWebhookController } from './top-up.webhook.controller';

export const topUpWebhookRoute = new Elysia({
  name: 'top-up-webhook-route',
  prefix: `${API_V1_PREFIX}/webhooks/xendit`,
}).post('/payments', receiveTopUpWebhookController, {
  response: responses(apiSuccessSchema, 400, 401, 409, 500, { successStatus: 202 }),
  detail: {
    tags: ['Xendit webhooks'],
    summary: 'Durably receive Xendit Top-up events',
    description: 'Authenticates and stores a Xendit Top-up event before acknowledging it. Financial effects are applied by a callable worker.',
    operationId: 'receiveXenditTopUpWebhook',
    security: [{ xenditWebhookAuth: [] }],
  },
});
