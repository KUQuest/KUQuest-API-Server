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

import { MoneyError } from './money.errors';
import { sha256, stableJson } from './money.crypto';
import {
  activityPageSchema,
  activityTypeSchema,
  earningsConversionSchema,
  moneyPolicySchema,
  walletSchema,
} from './money.schema';
import type { MoneyRepository } from './money.types';

export const createMoneyRoute = (
  repository: MoneyRepository,
  resolveSession: SessionResolver,
  trustedOrigins: readonly string[],
) =>
  new Elysia({ name: 'money-route', prefix: '/v1/wallet' })
    .get(
      '',
      async ({ request }) =>
        apiSuccess(
          await repository.getWallet(
            await requireAuthenticatedUserId(request.headers, resolveSession),
          ),
          request,
        ),
      {
        response: {
          200: apiSuccessSchema(walletSchema),
          401: apiFailureSchema,
        },
        detail: {
          tags: ['Wallet'],
          summary: "Get the authenticated user's wallet summary",
          operationId: 'getWallet',
          security: [{ betterAuthSession: [] }],
        },
      },
    )
    .get(
      '/policy',
      async ({ request }) => {
        await requireAuthenticatedUserId(request.headers, resolveSession);
        return apiSuccess(await repository.getPolicy(), request);
      },
      {
        response: {
          200: apiSuccessSchema(moneyPolicySchema),
          401: apiFailureSchema,
        },
        detail: {
          tags: ['Wallet'],
          summary: 'Get effective user-visible money policy',
          operationId: 'getMoneyPolicy',
          security: [{ betterAuthSession: [] }],
        },
      },
    )
    .get(
      '/activities',
      async ({ request, query }) => {
        const userId = await requireAuthenticatedUserId(
          request.headers,
          resolveSession,
        );
        return apiSuccess(
          await repository.listActivities(userId, {
            cursor: query.cursor,
            limit: query.limit ?? 20,
            type: query.type,
            status: query.status,
          }),
          request,
        );
      },
      {
        query: t.Object({
          cursor: t.Optional(t.String()),
          limit: t.Optional(
            t.Integer({ minimum: 1, maximum: 100, default: 20 }),
          ),
          type: t.Optional(activityTypeSchema),
          status: t.Optional(t.String()),
        }),
        response: {
          200: apiSuccessSchema(activityPageSchema),
          401: apiFailureSchema,
          422: apiFailureSchema,
        },
        detail: {
          tags: ['Wallet'],
          summary: 'List chronological wallet activity',
          operationId: 'listWalletActivities',
          security: [{ betterAuthSession: [] }],
        },
      },
    )
    .post(
      '/earnings-conversions',
      async ({ body, headers, request, status }) => {
        const userId = await requireTrustedMutationUserId(
          request.headers,
          resolveSession,
          trustedOrigins,
        );
        const idempotencyKey = headers['idempotency-key'];
        if (!idempotencyKey || idempotencyKey.length < 16) {
          throw new MoneyError(
            422,
            'VALIDATION_FAILED',
            'Idempotency-Key must contain between 16 and 100 characters.',
          );
        }

        const conversion = await repository.convertEarnings({
          userId,
          amount: body.amount,
          idempotencyKey,
          requestHash: await sha256(stableJson(body)),
        });

        return status(201, apiSuccess(conversion, request));
      },
      {
        body: t.Object({ amount: t.Integer({ minimum: 1 }) }),
        headers: t.Object(
          {
            'idempotency-key': t.String({ minLength: 16, maxLength: 100 }),
            origin: t.Optional(t.String()),
            referer: t.Optional(t.String()),
          },
          { additionalProperties: true },
        ),
        response: {
          201: apiSuccessSchema(earningsConversionSchema),
          401: apiFailureSchema,
          403: apiFailureSchema,
          409: apiFailureSchema,
          422: apiFailureSchema,
          423: apiFailureSchema,
        },
        detail: {
          tags: ['Earnings conversion'],
          summary: 'Irreversibly convert earnings into spending balance',
          operationId: 'createEarningsConversion',
          security: [{ betterAuthSession: [] }],
        },
      },
    );
