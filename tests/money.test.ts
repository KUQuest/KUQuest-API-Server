import { jwt } from '@elysia/jwt';
import { beforeEach, describe, expect, it } from 'bun:test';
import { Elysia, t } from 'elysia';

import { createApp } from '@/app';
import { InMemoryMoneyRepository } from '@/modules/money/in-memory-money.repository';

const jwtSecret = 'test-access-secret-that-is-long-enough';
const webhookToken = 'test-xendit-verification-token';

const tokenFor = async (userId: string): Promise<string> => {
  const signer = new Elysia()
    .use(
      jwt({
        name: 'accessJwt',
        secret: jwtSecret,
        schema: t.Object({ sub: t.String() }),
      }),
    )
    .get('/sign', ({ accessJwt }) => accessJwt.sign({ sub: userId }));
  const response = await signer.handle(new Request('http://localhost/sign'));
  return response.text();
};

const jsonRequest = (
  path: string,
  options: {
    token?: string;
    method?: string;
    body?: unknown;
    idempotencyKey?: string;
    callbackToken?: string;
  } = {},
) => {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (options.token) headers.set('authorization', `Bearer ${options.token}`);
  if (options.idempotencyKey) {
    headers.set('idempotency-key', options.idempotencyKey);
  }
  if (options.callbackToken) {
    headers.set('x-callback-token', options.callbackToken);
  }

  return new Request(`http://localhost${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
};

describe('money wallet vertical slice', () => {
  let repository: InMemoryMoneyRepository;
  let app: ReturnType<typeof createApp>;
  let token: string;

  beforeEach(async () => {
    repository = new InMemoryMoneyRepository();
    repository.seedWallet('user-1', { spending: 100, earnings: 500 });
    app = createApp({
      moneyRepository: repository,
      jwtAccessSecret: jwtSecret,
      xenditWebhookToken: webhookToken,
    });
    token = await tokenFor('user-1');
  });

  it('returns the authenticated wallet and current policy', async () => {
    const walletResponse = await app.handle(
      jsonRequest('/v1/wallet', { token }),
    );
    const wallet = await walletResponse.json();
    expect(walletResponse.status).toBe(200);
    expect(wallet.spending_balance).toBe(100);
    expect(wallet.earnings_balance).toBe(500);

    const policyResponse = await app.handle(
      jsonRequest('/v1/wallet/policy', { token }),
    );
    const policy = await policyResponse.json();
    expect(policyResponse.status).toBe(200);
    expect(policy.platform_fee_bps).toBe(200);
    expect(policy.quote_ttl_seconds).toBe(300);
  });

  it('rejects wallet reads without a valid bearer token', async () => {
    const response = await app.handle(jsonRequest('/v1/wallet'));
    const body = await response.json();
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain(
      'application/problem+json',
    );
    expect(body.code).toBe('UNAUTHORIZED');
    expect(body.trace_id).toEqual(expect.any(String));
  });

  it('converts earnings atomically and records wallet activity', async () => {
    const response = await app.handle(
      jsonRequest('/v1/wallet/earnings-conversions', {
        method: 'POST',
        token,
        idempotencyKey: 'conversion-request-0001',
        body: { amount: 300 },
      }),
    );
    const conversion = await response.json();
    expect(response.status).toBe(201);
    expect(conversion.earnings_balance_after).toBe(200);
    expect(conversion.spending_balance_after).toBe(400);

    const activityResponse = await app.handle(
      jsonRequest('/v1/wallet/activities', { token }),
    );
    const page = await activityResponse.json();
    expect(activityResponse.status).toBe(200);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      type: 'EARNINGS_CONVERSION',
      spending_delta: 300,
      earnings_delta: -300,
      resource: { type: 'CONVERSION', id: conversion.id },
    });
  });

  it('replays an identical idempotent request without moving value twice', async () => {
    const request = () =>
      jsonRequest('/v1/wallet/earnings-conversions', {
        method: 'POST',
        token,
        idempotencyKey: 'conversion-request-0002',
        body: { amount: 100 },
      });
    const first = await app.handle(request());
    const firstBody = await first.json();
    const replay = await app.handle(request());
    const replayBody = await replay.json();

    expect(replay.status).toBe(201);
    expect(replayBody).toEqual(firstBody);
    const wallet = await repository.getWallet('user-1');
    expect(wallet.earnings_balance).toBe(400);
    expect(wallet.spending_balance).toBe(200);
  });

  it('rejects conflicting idempotency-key reuse', async () => {
    const key = 'conversion-request-0003';
    await app.handle(
      jsonRequest('/v1/wallet/earnings-conversions', {
        method: 'POST',
        token,
        idempotencyKey: key,
        body: { amount: 100 },
      }),
    );
    const conflict = await app.handle(
      jsonRequest('/v1/wallet/earnings-conversions', {
        method: 'POST',
        token,
        idempotencyKey: key,
        body: { amount: 101 },
      }),
    );
    const body = await conflict.json();
    expect(conflict.status).toBe(409);
    expect(body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('prevents insufficient, frozen, fractional, and concurrent overspending', async () => {
    const tooLarge = await app.handle(
      jsonRequest('/v1/wallet/earnings-conversions', {
        method: 'POST',
        token,
        idempotencyKey: 'conversion-request-0004',
        body: { amount: 501 },
      }),
    );
    expect(tooLarge.status).toBe(422);
    expect((await tooLarge.json()).code).toBe(
      'INSUFFICIENT_EARNINGS_BALANCE',
    );

    const fractional = await app.handle(
      jsonRequest('/v1/wallet/earnings-conversions', {
        method: 'POST',
        token,
        idempotencyKey: 'conversion-request-0005',
        body: { amount: 1.5 },
      }),
    );
    expect(fractional.status).toBe(422);

    const concurrentRepository = new InMemoryMoneyRepository();
    concurrentRepository.seedWallet('user-1', { earnings: 500 });
    const concurrentApp = createApp({
      moneyRepository: concurrentRepository,
      jwtAccessSecret: jwtSecret,
      xenditWebhookToken: webhookToken,
    });
    const results = await Promise.all([
      concurrentApp.handle(
        jsonRequest('/v1/wallet/earnings-conversions', {
          method: 'POST',
          token,
          idempotencyKey: 'concurrent-conversion-01',
          body: { amount: 400 },
        }),
      ),
      concurrentApp.handle(
        jsonRequest('/v1/wallet/earnings-conversions', {
          method: 'POST',
          token,
          idempotencyKey: 'concurrent-conversion-02',
          body: { amount: 400 },
        }),
      ),
    ]);
    expect(results.map((result) => result.status).toSorted((a, b) => a - b)).toEqual([
      201, 422,
    ]);

    repository.seedWallet('user-1', { earnings: 500, status: 'FROZEN' });
    const frozen = await app.handle(
      jsonRequest('/v1/wallet/earnings-conversions', {
        method: 'POST',
        token,
        idempotencyKey: 'conversion-request-0006',
        body: { amount: 1 },
      }),
    );
    expect(frozen.status).toBe(423);
    expect((await frozen.json()).code).toBe('WALLET_FROZEN');
  });
});

describe('Xendit durable webhook acceptance', () => {
  it('authenticates, deduplicates, and stores a local payment fixture', async () => {
    const repository = new InMemoryMoneyRepository();
    const app = createApp({
      moneyRepository: repository,
      jwtAccessSecret: jwtSecret,
      xenditWebhookToken: webhookToken,
    });
    const payload = {
      event: 'payment.capture',
      business_id: 'business-test',
      created: '2026-07-13T10:00:00.000Z',
      data: {
        payment_id: 'py_test',
        payment_request_id: 'pr_test',
        reference_id: 'top_test',
        request_amount: 100,
        currency: 'THB',
        status: 'SUCCEEDED',
      },
    };

    const unauthorized = await app.handle(
      jsonRequest('/v1/webhooks/xendit/payments', {
        method: 'POST',
        callbackToken: 'wrong-token',
        body: payload,
      }),
    );
    expect(unauthorized.status).toBe(401);
    expect(repository.storedWebhookCount).toBe(0);

    const accepted = await app.handle(
      jsonRequest('/v1/webhooks/xendit/payments', {
        method: 'POST',
        callbackToken: webhookToken,
        body: payload,
      }),
    );
    const duplicate = await app.handle(
      jsonRequest('/v1/webhooks/xendit/payments', {
        method: 'POST',
        callbackToken: webhookToken,
        body: payload,
      }),
    );
    const redelivery = await app.handle(
      jsonRequest('/v1/webhooks/xendit/payments', {
        method: 'POST',
        callbackToken: webhookToken,
        body: { ...payload, created: '2026-07-13T10:01:00.000Z' },
      }),
    );
    expect(accepted.status).toBe(202);
    expect(duplicate.status).toBe(202);
    expect(redelivery.status).toBe(202);
    expect(repository.storedWebhookCount).toBe(1);

    const payoutPayload = {
      event: 'payout.succeeded',
      created: '2026-07-13T11:00:00.000Z',
      data: { payout_id: 'disb_test', status: 'SUCCEEDED' },
    };
    const payoutAccepted = await app.handle(
      jsonRequest('/v1/webhooks/xendit/payouts', {
        method: 'POST',
        callbackToken: webhookToken,
        body: payoutPayload,
      }),
    );
    const payoutRedelivery = await app.handle(
      jsonRequest('/v1/webhooks/xendit/payouts', {
        method: 'POST',
        callbackToken: webhookToken,
        body: { ...payoutPayload, created: '2026-07-13T11:01:00.000Z' },
      }),
    );
    expect(payoutAccepted.status).toBe(202);
    expect(payoutRedelivery.status).toBe(202);
    expect(repository.storedWebhookCount).toBe(2);
  });
});
