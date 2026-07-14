import { Elysia, t } from 'elysia';

import { constantTimeEqual, sha256, stableJson } from './money.crypto';
import { MoneyError } from './money.errors';
import type { MoneyRepository } from './money.types';

const failureResponse = (description: string) => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/ApiFailure' },
    },
  },
});

const recordWebhook = async (
  repository: MoneyRepository,
  payload: unknown,
  family: 'payment' | 'payout',
) => {
  const envelope: object =
    payload && typeof payload === 'object'
      ? payload
      : {};
  const data =
    'data' in envelope && envelope.data && typeof envelope.data === 'object'
      ? envelope.data
      : undefined;
  const eventType =
    'event' in envelope && typeof envelope.event === 'string'
      ? envelope.event
      : `${family}.status`;
  const objectIdCandidate =
    data && 'id' in data
      ? data.id
      : data && 'payout_id' in data
        ? data.payout_id
        : data && 'payment_id' in data
          ? data.payment_id
          : data && 'payment_request_id' in data
            ? data.payment_request_id
            : undefined;
  const objectId =
    typeof objectIdCandidate === 'string' ? objectIdCandidate : null;
  const canonicalPayload = stableJson(payload);
  const payloadHash = await sha256(canonicalPayload);
  const status =
    data && 'status' in data && typeof data.status === 'string'
      ? data.status
      : 'unknown';
  const eventKey = objectId
    ? await sha256(stableJson({ eventType, objectId, status, payloadHash }))
    : payloadHash;

  const stored = await repository.storeWebhook({
    provider: 'XENDIT',
    eventKey,
    payloadHash,
    eventType,
    objectId,
    payload,
    receivedAt: new Date().toISOString(),
  });
  console.info('Xendit webhook durably received', {
    family,
    eventType,
    status,
    objectId: objectId ?? 'missing',
    duplicate: stored.duplicate,
    payloadHashPrefix: payloadHash.slice(0, 12),
  });
  return stored;
};

const startWebhookDrain = (
  processStoredWebhooks: (() => Promise<unknown>) | undefined,
) => {
  if (!processStoredWebhooks) return;
  void processStoredWebhooks().catch((error: unknown) => {
    console.error('Xendit webhook background drain failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorMessage:
        error instanceof Error ? error.message : 'Unknown webhook drain error',
    });
  });
};

export const createXenditWebhookRoute = (
  repository: MoneyRepository,
  verificationToken: string | undefined,
  processStoredWebhooks?: () => Promise<unknown>,
) =>
  new Elysia({
    name: 'xendit-webhook-route',
    prefix: '/v1/webhooks/xendit',
  })
    .guard(
      {
        beforeHandle({ headers }) {
          const token = headers['x-callback-token'];
          if (
            !verificationToken ||
            !token ||
            !constantTimeEqual(token, verificationToken)
          ) {
            throw new MoneyError(
              401,
              'UNAUTHORIZED',
              'The Xendit callback token is invalid.',
            );
          }
        },
      },
      (app) =>
        app
          .post(
            '/payments',
            async ({ body }) => {
              await recordWebhook(repository, body, 'payment');
              startWebhookDrain(processStoredWebhooks);
              return new Response(null, { status: 202 });
            },
            {
              body: t.Record(t.String(), t.Unknown()),
              detail: {
                tags: ['Xendit webhooks'],
                summary: 'Persist Xendit payment events in the durable inbox',
                operationId: 'receiveXenditPaymentWebhook',
                security: [{ xenditWebhookAuth: [] }],
                responses: {
                  202: {
                    description:
                      'Authenticated event durably recorded or duplicate acknowledged.',
                  },
                  401: failureResponse('Invalid webhook authentication.'),
                  409: failureResponse(
                    'Provider event identifier reused with a different payload.',
                  ),
                },
              },
            },
          )
          .post(
            '/payouts',
            async ({ body }) => {
              await recordWebhook(repository, body, 'payout');
              startWebhookDrain(processStoredWebhooks);
              return new Response(null, { status: 202 });
            },
            {
              body: t.Record(t.String(), t.Unknown()),
              detail: {
                tags: ['Xendit webhooks'],
                summary: 'Persist Xendit payout events in the durable inbox',
                operationId: 'receiveXenditPayoutWebhook',
                security: [{ xenditWebhookAuth: [] }],
                responses: {
                  202: {
                    description:
                      'Authenticated event durably recorded or duplicate acknowledged.',
                  },
                  401: failureResponse('Invalid webhook authentication.'),
                  409: failureResponse(
                    'Provider event identifier reused with a different payload.',
                  ),
                },
              },
            },
          ),
    );
