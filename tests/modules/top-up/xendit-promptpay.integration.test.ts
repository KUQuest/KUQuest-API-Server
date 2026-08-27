import {
  InboundPaymentProviderError,
  XenditPromptPayProvider,
} from '@/modules/top-up';
import { positiveSatang } from '@/modules/wallet';

import { describe, expect, it } from 'bun:test';

describe('Xendit PromptPay provider', () => {
  it('creates a Payment Request v3 with the satang amount converted to THB', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const provider = new XenditPromptPayProvider({
      secretKey: 'test-secret',
      baseUrl: 'https://xendit.test',
      fetcher: async (input, init) => {
        requestUrl = input.toString();
        requestInit = init;
        return new Response(JSON.stringify({
          payment_request_id: 'pr-test-request',
          reference_id: 'top-up:test-reference',
          request_amount: 1.23,
          status: 'REQUIRES_ACTION',
          country: 'TH',
          currency: 'THB',
          channel_code: 'QRPROMPTPAY',
          channel_properties: { expires_at: '2026-08-26T10:05:00.000Z' },
          actions: [{ descriptor: 'QR_STRING', value: 'promptpay-qr' }],
        }), { status: 201 });
      },
    });

    const result = await provider.createPayment({
      internalReference: 'top-up:test-reference',
      paymentTotalSatang: positiveSatang(123),
      expiresAt: new Date('2026-08-26T10:05:00.000Z'),
    });

    expect(requestUrl).toBe('https://xendit.test/v3/payment_requests');
    expect(requestInit?.headers).toMatchObject({
      'api-version': '2024-11-11',
      'idempotency-key': 'top-up:test-reference',
    });
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      reference_id: 'top-up:test-reference',
      type: 'PAY',
      country: 'TH',
      currency: 'THB',
      request_amount: 1.23,
      capture_method: 'AUTOMATIC',
      channel_code: 'QRPROMPTPAY',
      channel_properties: {
        expires_at: '2026-08-26T10:05:00.000Z',
        qr_string_type: 'DYNAMIC',
      },
    });
    expect(result).toEqual({
      providerReference: 'pr-test-request',
      providerStatus: 'REQUIRES_ACTION',
      providerAmountSatang: positiveSatang(123),
      providerApiVersion: '2024-11-11',
      providerChannelCode: 'QRPROMPTPAY',
      qrPayload: 'promptpay-qr',
      qrExpiresAt: new Date('2026-08-26T10:05:00.000Z'),
    });
  });

  it('maps a provider rejection to a typed error', async () => {
    const provider = new XenditPromptPayProvider({
      secretKey: 'test-secret',
      fetcher: async () => new Response(JSON.stringify({
        error_code: 'CHANNEL_NOT_AVAILABLE',
        message: 'PromptPay is unavailable',
      }), { status: 422 }),
    });

    await expect(provider.createPayment({
      internalReference: 'top-up:rejected',
      paymentTotalSatang: positiveSatang(100),
      expiresAt: new Date('2026-08-26T10:05:00.000Z'),
    })).rejects.toMatchObject({
      code: 'PROVIDER_REJECTED',
      providerCode: 'CHANNEL_NOT_AVAILABLE',
    });
  });

  it('reconciles a Payment Request status and validates permanent references', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const provider = new XenditPromptPayProvider({
      secretKey: 'test-secret',
      baseUrl: 'https://xendit.test',
      fetcher: async (input, init) => {
        requestUrl = input.toString();
        requestInit = init;
        return new Response(JSON.stringify({
          payment_request_id: 'pr-test-request',
          reference_id: 'top-up:test-reference',
          request_amount: 1.23,
          status: 'SUCCEEDED',
          channel_code: 'QRPROMPTPAY',
          updated: '2026-08-27T00:00:00.000Z',
        }), { status: 200 });
      },
    });

    const result = await provider.getPaymentStatus({
      providerReference: 'pr-test-request',
      internalReference: 'top-up:test-reference',
      expectedPaymentTotalSatang: positiveSatang(123),
    });

    expect(requestUrl).toBe('https://xendit.test/v3/payment_requests/pr-test-request');
    expect(requestInit?.method).toBe('GET');
    expect(requestInit?.headers).toMatchObject({ 'api-version': '2024-11-11' });
    expect(result).toEqual({
      providerReference: 'pr-test-request',
      providerStatus: 'SUCCEEDED',
      normalizedStatus: 'PAID',
      providerAmountSatang: positiveSatang(123),
      providerApiVersion: '2024-11-11',
      providerChannelCode: 'QRPROMPTPAY',
      occurredAt: new Date('2026-08-27T00:00:00.000Z'),
    });
  });

  it('reconciles by internal reference when the Provider reference is unknown', async () => {
    let requestUrl = '';
    const provider = new XenditPromptPayProvider({
      secretKey: 'test-secret',
      baseUrl: 'https://xendit.test',
      fetcher: async (input) => {
        requestUrl = input.toString();
        return new Response(JSON.stringify({
          data: [{
            payment_request_id: 'pr-recovered-request',
            reference_id: 'top-up:recovered-reference',
            request_amount: 1.23,
            status: 'SUCCEEDED',
            channel_code: 'QRPROMPTPAY',
            updated: '2026-08-27T00:00:00.000Z',
          }],
        }), { status: 200 });
      },
    });

    const result = await provider.getPaymentStatus({
      providerReference: null,
      internalReference: 'top-up:recovered-reference',
      expectedPaymentTotalSatang: positiveSatang(123),
    });

    expect(requestUrl).toBe('https://xendit.test/v3/payment_requests?reference_id=top-up%3Arecovered-reference&limit=2');
    expect(result).toMatchObject({
      providerReference: 'pr-recovered-request',
      providerStatus: 'SUCCEEDED',
      normalizedStatus: 'PAID',
      providerAmountSatang: positiveSatang(123),
    });
  });

  it('maps a successful response without a provider amount to an uncertain result', async () => {
    const provider = new XenditPromptPayProvider({
      secretKey: 'test-secret',
      fetcher: async () => new Response(JSON.stringify({
        payment_request_id: 'pr-incomplete-response',
        reference_id: 'top-up:incomplete-response',
        status: 'REQUIRES_ACTION',
        country: 'TH',
        currency: 'THB',
        channel_code: 'QRPROMPTPAY',
        actions: [{ descriptor: 'QR_STRING', value: 'promptpay-qr' }],
      }), { status: 201 }),
    });

    await expect(provider.createPayment({
      internalReference: 'top-up:incomplete-response',
      paymentTotalSatang: positiveSatang(100),
      expiresAt: new Date('2026-08-26T10:05:00.000Z'),
    })).rejects.toMatchObject({ code: 'PROVIDER_UNCERTAIN' });
  });

  it('does not reconcile a confirmed payment without an exact amount', async () => {
    const provider = new XenditPromptPayProvider({
      secretKey: 'test-secret',
      fetcher: async () => new Response(JSON.stringify({
        payment_request_id: 'pr-no-amount',
        reference_id: 'top-up:no-amount',
        status: 'SUCCEEDED',
      }), { status: 200 }),
    });

    await expect(provider.getPaymentStatus({
      providerReference: 'pr-no-amount',
      internalReference: 'top-up:no-amount',
      expectedPaymentTotalSatang: positiveSatang(100),
    })).rejects.toMatchObject({ code: 'PROVIDER_UNCERTAIN' });
  });

  it('maps a timeout to an uncertain provider result', async () => {
    const provider = new XenditPromptPayProvider({
      secretKey: 'test-secret',
      timeoutMs: 1,
      fetcher: (_input, init) => new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }),
    });

    await expect(provider.createPayment({
      internalReference: 'top-up:timeout',
      paymentTotalSatang: positiveSatang(100),
      expiresAt: new Date('2026-08-26T10:05:00.000Z'),
    })).rejects.toBeInstanceOf(InboundPaymentProviderError);
    await expect(provider.createPayment({
      internalReference: 'top-up:timeout-again',
      paymentTotalSatang: positiveSatang(100),
      expiresAt: new Date('2026-08-26T10:05:00.000Z'),
    })).rejects.toMatchObject({ code: 'PROVIDER_UNCERTAIN' });
  });
});
