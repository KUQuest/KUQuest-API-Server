import { Elysia, t } from 'elysia';

import {
  apiFailureSchema,
  apiSuccess,
  apiSuccessSchema,
} from '@/http/api-response';
import {
  requireAuthenticatedUserId,
  requireTrustedMutationUserId,
  type SessionResolver,
} from '@/modules/auth';

import { MoneyError } from '../money/money.errors';
import {
  idempotencyHeadersSchema,
  payoutAccountInputSchema,
  payoutAccountSchema,
  payoutQuoteSchema,
  payoutSchema,
  quoteIdBodySchema,
  resourceIdParamsSchema,
  topUpQuoteSchema,
  topUpSchema,
} from './payments.schema';
import type { PaymentsRepository } from './payments.types';

const mutationUserId = (
  headers: Headers,
  resolver: SessionResolver,
  trustedOrigins: readonly string[],
) => requireTrustedMutationUserId(headers, resolver, trustedOrigins);

export const createPaymentsRoute = (
  repository: PaymentsRepository,
  resolver: SessionResolver,
  trustedOrigins: readonly string[],
  developmentEnabled: boolean,
) =>
  new Elysia({ name: 'payments-route', prefix: '/v1/wallet' })
    .post(
      '/top-up-quotes',
      async ({ body, request, status }) =>
        status(
          201,
          apiSuccess(
            await repository.createTopUpQuote(
              await mutationUserId(request.headers, resolver, trustedOrigins),
              body.credit_baht,
            ),
            request,
          ),
        ),
      {
        body: t.Object({ credit_baht: t.Integer({ minimum: 1 }) }),
        response: {
          201: apiSuccessSchema(topUpQuoteSchema),
          401: apiFailureSchema,
          403: apiFailureSchema,
          422: apiFailureSchema,
        },
        detail: {
          tags: ['Top-ups'],
          summary: 'Quote a PromptPay wallet top-up',
          security: [{ betterAuthSession: [] }],
        },
      },
    )
    .post(
      '/top-ups',
      async ({ body, headers, request, status }) =>
        status(
          201,
          apiSuccess(
            await repository.createTopUp(
              await mutationUserId(request.headers, resolver, trustedOrigins),
              body.quote_id,
              headers['idempotency-key'],
            ),
            request,
          ),
        ),
      {
        body: quoteIdBodySchema,
        headers: idempotencyHeadersSchema,
        response: {
          201: apiSuccessSchema(topUpSchema),
          401: apiFailureSchema,
          403: apiFailureSchema,
          404: apiFailureSchema,
          409: apiFailureSchema,
          422: apiFailureSchema,
          503: apiFailureSchema,
        },
        detail: {
          tags: ['Top-ups'],
          summary: 'Create a real Xendit PromptPay request',
          security: [{ betterAuthSession: [] }],
        },
      },
    )
    .get(
      '/top-ups',
      async ({ request }) =>
        apiSuccess(
          await repository.listTopUps(
            await requireAuthenticatedUserId(request.headers, resolver),
          ),
          request,
        ),
      {
        response: {
          200: apiSuccessSchema(t.Array(topUpSchema)),
          401: apiFailureSchema,
        },
        detail: {
          tags: ['Top-ups'],
          summary: 'List top-ups',
          security: [{ betterAuthSession: [] }],
        },
      },
    )
    .get(
      '/top-ups/:id',
      async ({ params, request }) =>
        apiSuccess(
          await repository.getTopUp(
            await requireAuthenticatedUserId(request.headers, resolver),
            params.id,
          ),
          request,
        ),
      {
        params: resourceIdParamsSchema,
        response: {
          200: apiSuccessSchema(topUpSchema),
          401: apiFailureSchema,
          404: apiFailureSchema,
        },
        detail: {
          tags: ['Top-ups'],
          summary: 'Get top-up status',
          security: [{ betterAuthSession: [] }],
        },
      },
    )
    .post(
      '/top-ups/:id/simulate',
      async ({ params, request }) => {
        if (!developmentEnabled) {
          throw new MoneyError(
            404,
            'NOT_FOUND',
            'The requested resource was not found.',
          );
        }
        return apiSuccess(
          await repository.simulateTopUp(
            await mutationUserId(request.headers, resolver, trustedOrigins),
            params.id,
          ),
          request,
        );
      },
      {
        params: resourceIdParamsSchema,
        response: {
          200: apiSuccessSchema(topUpSchema),
          401: apiFailureSchema,
          403: apiFailureSchema,
          404: apiFailureSchema,
          409: apiFailureSchema,
          503: apiFailureSchema,
        },
        detail: {
          tags: ['Development money testing'],
          summary: 'Ask Xendit test mode to simulate payment',
          security: [{ betterAuthSession: [] }],
        },
      },
    )
    .get(
      '/payout-account',
      async ({ request }) =>
        apiSuccess(
          await repository.getPayoutAccount(
            await requireAuthenticatedUserId(request.headers, resolver),
          ),
          request,
        ),
      {
        response: {
          200: apiSuccessSchema(t.Nullable(payoutAccountSchema)),
          401: apiFailureSchema,
        },
        detail: {
          tags: ['Payouts'],
          summary: 'Get the active payout account',
          security: [{ betterAuthSession: [] }],
        },
      },
    )
    .post(
      '/payout-account',
      async ({ body, request, status }) =>
        status(
          201,
          apiSuccess(
            await repository.savePayoutAccount(
              await mutationUserId(request.headers, resolver, trustedOrigins),
              body,
            ),
            request,
          ),
        ),
      {
        body: payoutAccountInputSchema,
        response: {
          201: apiSuccessSchema(payoutAccountSchema),
          401: apiFailureSchema,
          403: apiFailureSchema,
          422: apiFailureSchema,
        },
        detail: {
          tags: ['Payouts'],
          summary: 'Replace the active payout destination',
          security: [{ betterAuthSession: [] }],
        },
      },
    )
    .post(
      '/payout-quotes',
      async ({ body, request, status }) =>
        status(
          201,
          apiSuccess(
            await repository.createPayoutQuote(
              await mutationUserId(request.headers, resolver, trustedOrigins),
              body.receipt_baht,
            ),
            request,
          ),
        ),
      {
        body: t.Object({ receipt_baht: t.Integer({ minimum: 1 }) }),
        response: {
          201: apiSuccessSchema(payoutQuoteSchema),
          401: apiFailureSchema,
          403: apiFailureSchema,
          422: apiFailureSchema,
        },
        detail: {
          tags: ['Payouts'],
          summary: 'Quote an earnings payout',
          security: [{ betterAuthSession: [] }],
        },
      },
    )
    .post(
      '/payouts',
      async ({ body, headers, request, status }) =>
        status(
          201,
          apiSuccess(
            await repository.createPayout(
              await mutationUserId(request.headers, resolver, trustedOrigins),
              body.quote_id,
              headers['idempotency-key'],
            ),
            request,
          ),
        ),
      {
        body: quoteIdBodySchema,
        headers: idempotencyHeadersSchema,
        response: {
          201: apiSuccessSchema(payoutSchema),
          401: apiFailureSchema,
          403: apiFailureSchema,
          404: apiFailureSchema,
          409: apiFailureSchema,
          422: apiFailureSchema,
          503: apiFailureSchema,
        },
        detail: {
          tags: ['Payouts'],
          summary: 'Reserve earnings and submit a real Xendit test payout',
          security: [{ betterAuthSession: [] }],
        },
      },
    )
    .get(
      '/payouts',
      async ({ request }) =>
        apiSuccess(
          await repository.listPayouts(
            await requireAuthenticatedUserId(request.headers, resolver),
          ),
          request,
        ),
      {
        response: {
          200: apiSuccessSchema(t.Array(payoutSchema)),
          401: apiFailureSchema,
        },
        detail: {
          tags: ['Payouts'],
          summary: 'List payouts',
          security: [{ betterAuthSession: [] }],
        },
      },
    )
    .get(
      '/payouts/:id',
      async ({ params, request }) =>
        apiSuccess(
          await repository.getPayout(
            await requireAuthenticatedUserId(request.headers, resolver),
            params.id,
          ),
          request,
        ),
      {
        params: resourceIdParamsSchema,
        response: {
          200: apiSuccessSchema(payoutSchema),
          401: apiFailureSchema,
          404: apiFailureSchema,
        },
        detail: {
          tags: ['Payouts'],
          summary: 'Get payout status',
          security: [{ betterAuthSession: [] }],
        },
      },
    );
