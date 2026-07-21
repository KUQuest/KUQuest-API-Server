import { describe, expect, it } from 'bun:test';

import { HttpXenditClient } from '@/modules/payments/xendit.client';
import { MoneyError } from '@/modules/money/money.errors';

describe('Xendit HTTP client', () => {
  it('creates Thai PromptPay requests with the enabled V3 channel code', async () => {
    let requestUrl = '';
    let requestBody: Record<string, unknown> = {};
    const fetcher = async (input: string, init?: RequestInit) => {
      requestUrl = input;
      if (typeof init?.body !== 'string')
        throw new TypeError('Expected a JSON request body.');
      requestBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          payment_request_id: 'pr-35c82074-06c5-44c3-8d13-8f3ea81c4dff',
          status: 'REQUIRES_ACTION',
          actions: [{ descriptor: 'QR_STRING', value: 'promptpay-test-value' }],
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    };
    const client = new HttpXenditClient(
      'test-secret',
      'https://xendit.test',
      fetcher,
    );

    const result = await client.createPromptPay({
      reference: 'kuquest-topup-test',
      amountBaht: 500,
      expiresAt: '2026-07-14T15:00:00.000Z',
    });

    expect(requestUrl).toBe('https://xendit.test/v3/payment_requests');
    expect(requestBody).toMatchObject({
      country: 'TH',
      currency: 'THB',
      channel_code: 'PROMPTPAY',
      request_amount: 500,
    });
    expect(result).toEqual({
      paymentRequestId: 'pr-35c82074-06c5-44c3-8d13-8f3ea81c4dff',
      status: 'REQUIRES_ACTION',
      qrString: 'promptpay-test-value',
      expiresAt: '2026-07-14T15:00:00.000Z',
    });
  });

  it('includes the stored payment amount when simulating a test payment', async () => {
    let requestUrl = '';
    let requestBody: Record<string, unknown> = {};
    const fetcher = async (input: string, init?: RequestInit) => {
      requestUrl = input;
      if (typeof init?.body !== 'string')
        throw new TypeError('Expected a JSON request body.');
      requestBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ status: 'PENDING' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = new HttpXenditClient(
      'test-secret',
      'https://xendit.test',
      fetcher,
    );

    const result = await client.simulatePayment('pr-test-request', 500);

    expect(requestUrl).toBe(
      'https://xendit.test/v3/payment_requests/pr-test-request/simulate',
    );
    expect(requestBody).toEqual({ amount: 500 });
    expect(result).toEqual({ status: 'PENDING' });
  });

  it('maps malformed successful provider responses to a controlled 503', async () => {
    const client = new HttpXenditClient(
      'test-secret',
      'https://xendit.test',
      async () =>
        new Response('null', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const error = await client
      .simulatePayment('pr-invalid-response', 500)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(MoneyError);
    expect(error).toMatchObject({
      status: 503,
      code: 'PROVIDER_UNAVAILABLE',
    });
  });
});
