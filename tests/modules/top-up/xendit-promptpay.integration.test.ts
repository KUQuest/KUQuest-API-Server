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
