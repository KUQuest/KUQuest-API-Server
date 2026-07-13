import { Elysia, t } from 'elysia';

import {
  assertTrustedBrowserOrigin,
  type SessionResolver,
} from '@/modules/auth';

import { MoneyError } from './money.errors';
import { sha256, stableJson } from './money.crypto';
import {
  activityPageSchema,
  activityTypeSchema,
  earningsConversionSchema,
  moneyPolicySchema,
  problemSchema,
  walletSchema,
} from './money.schema';
import type { MoneyRepository } from './money.types';

const currentUserId = async (
  headers: Headers,
  resolveSession: SessionResolver,
): Promise<string> => {
  const session = await resolveSession(headers);
  if (!session?.user.id) {
    throw new MoneyError(401, 'UNAUTHORIZED', 'A valid session is required.');
  }

  return session.user.id;
};

export const createMoneyRoute = (
  repository: MoneyRepository,
  resolveSession: SessionResolver,
  trustedOrigins: readonly string[],
) =>
  new Elysia({ name: 'money-route', prefix: '/v1/wallet' })
    .get(
      '',
      async ({ request }) =>
        repository.getWallet(await currentUserId(request.headers, resolveSession)),
      {
        response: { 200: walletSchema, 401: problemSchema },
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
        await currentUserId(request.headers, resolveSession);
        return repository.getPolicy();
      },
      {
        response: { 200: moneyPolicySchema, 401: problemSchema },
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
        const userId = await currentUserId(request.headers, resolveSession);
        return repository.listActivities(userId, {
          cursor: query.cursor,
          limit: query.limit ?? 20,
          type: query.type,
          status: query.status,
        });
      },
      {
        query: t.Object({
          cursor: t.Optional(t.String()),
          limit: t.Optional(t.Integer({ minimum: 1, maximum: 100, default: 20 })),
          type: t.Optional(activityTypeSchema),
          status: t.Optional(t.String()),
        }),
        response: {
          200: activityPageSchema,
          401: problemSchema,
          422: problemSchema,
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
        const userId = await currentUserId(request.headers, resolveSession);
        assertTrustedBrowserOrigin(request.headers, trustedOrigins);
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

        return status(201, conversion);
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
          201: earningsConversionSchema,
          401: problemSchema,
          403: problemSchema,
          409: problemSchema,
          422: problemSchema,
          423: problemSchema,
        },
        detail: {
          tags: ['Earnings conversion'],
          summary: 'Irreversibly convert earnings into spending balance',
          operationId: 'createEarningsConversion',
          security: [{ betterAuthSession: [] }],
        },
      },
    );
