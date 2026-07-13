import { jwt } from '@elysia/jwt';
import { Elysia, t } from 'elysia';

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

interface JwtVerifier {
  verify(token?: string): Promise<{ sub: string } | false>;
}

const currentUserId = async (
  authorization: string | undefined,
  verifier: JwtVerifier,
): Promise<string> => {
  if (!authorization?.startsWith('Bearer ')) {
    throw new MoneyError(401, 'UNAUTHORIZED', 'A bearer access token is required.');
  }

  const payload = await verifier.verify(authorization.slice('Bearer '.length));
  if (!payload || !payload.sub) {
    throw new MoneyError(401, 'UNAUTHORIZED', 'The access token is invalid.');
  }

  return payload.sub;
};

export const createMoneyRoute = (
  repository: MoneyRepository,
  jwtSecret: string,
) =>
  new Elysia({ name: 'money-route', prefix: '/v1/wallet' })
    .use(
      jwt({
        name: 'accessJwt',
        secret: jwtSecret,
        schema: t.Object({ sub: t.String({ minLength: 1 }) }),
      }),
    )
    .get(
      '',
      async ({ accessJwt, headers }) =>
        repository.getWallet(
          await currentUserId(headers.authorization, accessJwt),
        ),
      {
        response: { 200: walletSchema, 401: problemSchema },
        detail: {
          tags: ['Wallet'],
          summary: "Get the authenticated user's wallet summary",
          operationId: 'getWallet',
          security: [{ sessionAuth: [] }],
        },
      },
    )
    .get(
      '/policy',
      async ({ accessJwt, headers }) => {
        await currentUserId(headers.authorization, accessJwt);
        return repository.getPolicy();
      },
      {
        response: { 200: moneyPolicySchema, 401: problemSchema },
        detail: {
          tags: ['Wallet'],
          summary: 'Get effective user-visible money policy',
          operationId: 'getMoneyPolicy',
          security: [{ sessionAuth: [] }],
        },
      },
    )
    .get(
      '/activities',
      async ({ accessJwt, headers, query }) => {
        const userId = await currentUserId(headers.authorization, accessJwt);
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
          security: [{ sessionAuth: [] }],
        },
      },
    )
    .post(
      '/earnings-conversions',
      async ({ accessJwt, body, headers, status }) => {
        const userId = await currentUserId(headers.authorization, accessJwt);
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
            authorization: t.Optional(t.String()),
          },
          { additionalProperties: true },
        ),
        response: {
          201: earningsConversionSchema,
          401: problemSchema,
          409: problemSchema,
          422: problemSchema,
          423: problemSchema,
        },
        detail: {
          tags: ['Earnings conversion'],
          summary: 'Irreversibly convert earnings into spending balance',
          operationId: 'createEarningsConversion',
          security: [{ sessionAuth: [] }],
        },
      },
    );
