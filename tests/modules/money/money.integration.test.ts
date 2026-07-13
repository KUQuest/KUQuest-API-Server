import { beforeEach, describe, expect, it } from 'bun:test';

import { createApp } from '@/app';
import { InMemoryMoneyRepository } from '@/modules/money/in-memory-money.repository';

const webhookToken = 'test-xendit-verification-token';

const jsonRequest = (
  path: string,
  options: {
    authorization?: string;
    method?: string;
    body?: unknown;
    idempotencyKey?: string;
    callbackToken?: string;
    cookie?: string;
  } = {},
) => {
  const headers = new Headers({
    'content-type': 'application/json',
    origin: 'http://localhost:3000',
  });
  if (options.authorization) {
    headers.set('authorization', options.authorization);
  }
  if (options.idempotencyKey) {
    headers.set('idempotency-key', options.idempotencyKey);
  }
  if (options.callbackToken) {
    headers.set('x-callback-token', options.callbackToken);
  }
  if (options.cookie) headers.set('cookie', options.cookie);

  return new Request(`http://localhost${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
};

describe('money wallet vertical slice', () => {
  let repository: InMemoryMoneyRepository;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    repository = new InMemoryMoneyRepository();
    repository.seedWallet('user-1', { spending: 100, earnings: 500 });
    app = createApp({
      moneyRepository: repository,
      sessionResolver: async () => ({ user: { id: 'user-1' } }),
      trustedOrigins: ['http://localhost:3000'],
      xenditWebhookToken: webhookToken,
    });
  });

  it('returns the authenticated wallet and current policy', async () => {
    const walletResponse = await app.handle(
      jsonRequest('/v1/wallet'),
    );
    const wallet = await walletResponse.json();
    expect(walletResponse.status).toBe(200);
    expect(wallet.spending_balance).toBe(100);
    expect(wallet.earnings_balance).toBe(500);

    const policyResponse = await app.handle(
      jsonRequest('/v1/wallet/policy'),
    );
    const policy = await policyResponse.json();
    expect(policyResponse.status).toBe(200);
    expect(policy.platform_fee_bps).toBe(200);
    expect(policy.quote_ttl_seconds).toBe(300);
  });

  it('passes request cookies to the injectable session resolver', async () => {
    let receivedCookie: string | null = null;
    const sessionApp = createApp({
      moneyRepository: repository,
      sessionResolver: async (headers) => {
        receivedCookie = headers.get('cookie');
        return { user: { id: 'user-1' } };
      },
      trustedOrigins: ['http://localhost:3000'],
      xenditWebhookToken: webhookToken,
    });

    const response = await sessionApp.handle(
      jsonRequest('/v1/wallet', { cookie: 'better-auth.session_token=opaque' }),
    );
    expect(response.status).toBe(200);
    expect(String(receivedCookie)).toBe('better-auth.session_token=opaque');
  });

  it('rejects wallet reads without a Better Auth session, even with a bearer token', async () => {
    const anonymousApp = createApp({
      moneyRepository: repository,
      sessionResolver: async () => null,
      trustedOrigins: ['http://localhost:3000'],
      xenditWebhookToken: webhookToken,
    });
    const response = await anonymousApp.handle(
      jsonRequest('/v1/wallet', { authorization: 'Bearer obsolete.jwt.token' }),
    );
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
        idempotencyKey: 'conversion-request-0001',
        body: { amount: 300 },
      }),
    );
    const conversion = await response.json();
    expect(response.status).toBe(201);
    expect(conversion.earnings_balance_after).toBe(200);
    expect(conversion.spending_balance_after).toBe(400);

    const activityResponse = await app.handle(
      jsonRequest('/v1/wallet/activities'),
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
        idempotencyKey: key,
        body: { amount: 100 },
      }),
    );
    const conflict = await app.handle(
      jsonRequest('/v1/wallet/earnings-conversions', {
        method: 'POST',
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
        idempotencyKey: 'conversion-request-0005',
        body: { amount: 1.5 },
      }),
    );
    expect(fractional.status).toBe(422);

    const concurrentRepository = new InMemoryMoneyRepository();
    concurrentRepository.seedWallet('user-1', { earnings: 500 });
    const concurrentApp = createApp({
      moneyRepository: concurrentRepository,
      sessionResolver: async () => ({ user: { id: 'user-1' } }),
      trustedOrigins: ['http://localhost:3000'],
      xenditWebhookToken: webhookToken,
    });
    const results = await Promise.all([
      concurrentApp.handle(
        jsonRequest('/v1/wallet/earnings-conversions', {
          method: 'POST',
          idempotencyKey: 'concurrent-conversion-01',
          body: { amount: 400 },
        }),
      ),
      concurrentApp.handle(
        jsonRequest('/v1/wallet/earnings-conversions', {
          method: 'POST',
          idempotencyKey: 'concurrent-conversion-02',
          body: { amount: 400 },
        }),
      ),
    ]);
    expect(results.filter((result) => result.status === 201)).toHaveLength(1);
    expect(results.filter((result) => result.status === 422)).toHaveLength(1);

    repository.seedWallet('user-1', { earnings: 500, status: 'FROZEN' });
    const frozen = await app.handle(
      jsonRequest('/v1/wallet/earnings-conversions', {
        method: 'POST',
        idempotencyKey: 'conversion-request-0006',
        body: { amount: 1 },
      }),
    );
    expect(frozen.status).toBe(423);
    expect((await frozen.json()).code).toBe('WALLET_FROZEN');
  });

  it('rejects a cross-site earnings conversion before changing balances', async () => {
    const request = jsonRequest('/v1/wallet/earnings-conversions', {
      method: 'POST',
      idempotencyKey: 'cross-site-request-0001',
      body: { amount: 100 },
    });
    request.headers.set('origin', 'https://attacker.example');
    request.headers.set('sec-fetch-site', 'cross-site');

    const response = await app.handle(request);
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('FORBIDDEN');
    expect((await repository.getWallet('user-1')).earnings_balance).toBe(500);
  });

  it('accepts a trusted Referer when Origin is unavailable', async () => {
    const request = jsonRequest('/v1/wallet/earnings-conversions', {
      method: 'POST',
      idempotencyKey: 'trusted-referer-request-0001',
      body: { amount: 100 },
    });
    request.headers.delete('origin');
    request.headers.set('referer', 'http://localhost:3000/wallet');

    const response = await app.handle(request);
    expect(response.status).toBe(201);
  });
});

describe('Xendit durable webhook acceptance', () => {
  it('authenticates, deduplicates, and stores a local payment fixture', async () => {
    const repository = new InMemoryMoneyRepository();
    const app = createApp({
      moneyRepository: repository,
      sessionResolver: async () => null,
      trustedOrigins: ['http://localhost:3000'],
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
    const conflictingRedelivery = await app.handle(
      jsonRequest('/v1/webhooks/xendit/payments', {
        method: 'POST',
        callbackToken: webhookToken,
        body: { ...payload, created: '2026-07-13T10:01:00.000Z' },
      }),
    );
    expect(accepted.status).toBe(202);
    expect(duplicate.status).toBe(202);
    expect(conflictingRedelivery.status).toBe(409);
    expect((await conflictingRedelivery.json()).code).toBe(
      'IDEMPOTENCY_CONFLICT',
    );
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
    expect(payoutRedelivery.status).toBe(409);
    expect(repository.storedWebhookCount).toBe(2);
  });
});
