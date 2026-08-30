import {
  PayoutProviderError,
  XenditPayoutProvider,
  XENDIT_PAYOUT_API_VERSION,
} from '@/modules/payout';
import { positiveSatang, satang } from '@/modules/wallet';
import type {
  Fetcher,
  OutboundPayoutRequest,
} from '@/modules/payout';

import { describe, expect, it } from 'bun:test';

const destination = {
  id: 'destination-id',
  principalUserId: 'student-id',
  recipientType: 'SELF' as const,
  givenName: 'Payout',
  surname: 'Student',
  relationship: 'SELF',
  accountCountry: 'TH' as const,
  accountCurrency: 'THB' as const,
  bankCode: 'SCB',
  accountHolderName: 'Payout Student',
  routingType: 'BANK_ACCOUNT' as const,
  maskedLastFour: '7890',
  maskedRoutingValue: '****7890',
  accountNumber: '1234567890',
  routingValue: '1234567890',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  retiredAt: null,
};

const request: OutboundPayoutRequest = {
  internalReference: 'payout:123',
  receiptSatang: positiveSatang(12_345),
  maximumFeeSatang: satang(0),
  maximumTaxSatang: satang(0),
  maximumDebitSatang: positiveSatang(12_345),
  destination,
};

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

describe('Xendit Payout provider', () => {
  it('fetches and normalizes the current Payout state for reconciliation', async () => {
    let called: { url: string; init?: RequestInit } | undefined;
    const provider = new XenditPayoutProvider({
      secretKey: 'xnd_test_secret',
      fetcher: async (url, init) => {
        called = { url, init };
        return response({
          payout_id: 'po-reconcile-123',
          reference_id: request.internalReference,
          status: 'SUCCEEDED',
          source_currency: 'THB',
          source_amount: 123.45,
          fee: 0.1,
          tax: 0.05,
          updated: '2026-08-27T00:01:00.000Z',
        });
      },
      baseUrl: 'https://xendit.test',
    });

    const result = await provider.getPayoutStatus({
      providerReference: 'po-reconcile-123',
      internalReference: request.internalReference,
      expectedPrincipalSatang: positiveSatang(12_345),
      maximumDebitSatang: positiveSatang(12_400),
    });

    expect(called?.url).toBe('https://xendit.test/v3/payouts/po-reconcile-123');
    expect(called?.init?.method).toBe('GET');
    expect(result).toMatchObject({
      providerReference: 'po-reconcile-123',
      normalizedStatus: 'COMPLETED',
      providerAmountSatang: 12_345,
      actualFeeSatang: 10,
      actualTaxSatang: 5,
      actualDebitSatang: 12_360,
    });
  });

  it('keeps a Provider failure as a normal reconciliation result', async () => {
    const provider = new XenditPayoutProvider({
      secretKey: 'xnd_test_secret',
      fetcher: async () => response({
        payout_id: 'po-reconcile-failed',
        reference_id: request.internalReference,
        status: 'FAILED',
        source_currency: 'THB',
        source_amount: 123.45,
      }),
    });

    await expect(provider.getPayoutStatus({
      providerReference: 'po-reconcile-failed',
      internalReference: request.internalReference,
      expectedPrincipalSatang: positiveSatang(12_345),
      maximumDebitSatang: positiveSatang(12_345),
    })).resolves.toMatchObject({ normalizedStatus: 'FAILED' });
  });

  it('sends the exact staging-compatible V2 SCB request with stable idempotency', async () => {
    let called: { url: string; init?: RequestInit } | undefined;
    const fetcher: Fetcher = async (url, init) => {
      called = { url, init };
      return response({
        id: 'xnd-payout-123',
        reference_id: request.internalReference,
        status: 'ACCEPTED',
        amount: 123.45,
        currency: 'THB',
        channel_code: 'SCB',
      });
    };

    const provider = new XenditPayoutProvider({
      secretKey: 'xnd_test_secret',
      fetcher,
      baseUrl: 'https://xendit.test',
    });
    const result = await provider.createPayout(request);
    const body = JSON.parse(String(called?.init?.body));

    expect(called?.url).toBe('https://xendit.test/v2/payouts');
    expect(called?.init?.method).toBe('POST');
    expect(new Headers(called?.init?.headers).get('authorization')).toBe('Basic eG5kX3Rlc3Rfc2VjcmV0Og==');
    expect(XENDIT_PAYOUT_API_VERSION).toBe('2020-02-01');
    expect(new Headers(called?.init?.headers).get('api-version')).toBe(XENDIT_PAYOUT_API_VERSION);
    expect(new Headers(called?.init?.headers).get('idempotency-key')).toBe(request.internalReference);
    expect(body).toEqual({
      reference_id: request.internalReference,
      channel_code: 'SCB',
      channel_properties: { account_number: destination.accountNumber },
      amount: 123.45,
      currency: 'THB',
      description: 'KUQuest Payout',
      metadata: { kuquest_reference: request.internalReference },
    });
    expect(result).toMatchObject({
      providerReference: 'xnd-payout-123',
      providerStatus: 'ACCEPTED',
      providerAmountSatang: 12_345,
      actualFeeSatang: 0,
      actualTaxSatang: 0,
      actualDebitSatang: 12_345,
      providerApiVersion: XENDIT_PAYOUT_API_VERSION,
    });
  });

  it('accepts explicit zero Provider fee and tax values', async () => {
    const provider = new XenditPayoutProvider({
      secretKey: 'xnd_test_secret',
      fetcher: async () => response({
        id: 'xnd-payout-zero-fees',
        reference_id: request.internalReference,
        status: 'ACCEPTED',
        amount: 123.45,
        fee: 0,
        tax: 0,
        currency: 'THB',
      channel_code: 'SCB',
      }),
    });

    await expect(provider.createPayout(request)).resolves.toMatchObject({
      actualFeeSatang: 0,
      actualTaxSatang: 0,
      actualDebitSatang: 12_345,
    });
  });

  it('detects a confirmed failed Payout in a successful Xendit response', async () => {
    const provider = new XenditPayoutProvider({
      secretKey: 'xnd_test_secret',
      fetcher: async () => response({
        id: 'xnd-payout-failed',
        reference_id: request.internalReference,
        status: 'FAILED',
      }),
    });

    await expect(provider.createPayout(request)).rejects.toMatchObject({
      code: 'PROVIDER_REJECTED',
    });
  });

  it('treats a reversed Payout as a confirmed Provider failure', async () => {
    const provider = new XenditPayoutProvider({
      secretKey: 'xnd_test_secret',
      fetcher: async () => response({
        id: 'xnd-payout-reversed',
        reference_id: request.internalReference,
        status: 'REVERSED',
      }),
    });

    await expect(provider.createPayout(request)).rejects.toMatchObject({
      code: 'PROVIDER_REJECTED',
      providerCode: 'REVERSED',
    });
  });

  it('does not treat a terminal success status as an in-flight response', async () => {
    const provider = new XenditPayoutProvider({
      secretKey: 'xnd_test_secret',
      fetcher: async () => response({
        id: 'xnd-payout-succeeded',
        reference_id: request.internalReference,
        status: 'SUCCEEDED',
        amount: 123.45,
        currency: 'THB',
        channel_code: 'SCB',
      }),
    });

    await expect(provider.createPayout(request)).rejects.toMatchObject({
      code: 'PROVIDER_UNCERTAIN',
    });
  });

  it('uses PromptPay routing at the provider boundary', async () => {
    let body: Record<string, unknown> | undefined;
    const fetcher: Fetcher = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return response({
        id: 'xnd-promptpay-123',
        status: 'ACCEPTED',
        amount: 100,
        currency: 'THB',
      });
    };
    const promptPayRequest = {
      ...request,
      receiptSatang: positiveSatang(10_000),
      maximumDebitSatang: positiveSatang(10_000),
      destination: {
        ...destination,
        bankCode: 'PROMPTPAY',
        routingType: 'PROMPTPAY' as const,
        accountNumber: '0000000000',
        routingValue: '0812345678',
      },
    };

    await new XenditPayoutProvider({ secretKey: 'secret', fetcher }).createPayout(promptPayRequest);

    expect(body).toMatchObject({
      channel_code: 'PROMPTPAY',
      channel_properties: { account_number: '0812345678' },
    });
  });

  it('maps rejection, uncertainty, timeout, and provider amount mismatch', async () => {
    const rejected = new XenditPayoutProvider({
      secretKey: 'secret',
      fetcher: async () => response({ error_code: 'INVALID_CHANNEL', message: 'bad channel' }, 400),
    });
    await expect(rejected.createPayout(request)).rejects.toMatchObject({
      code: 'PROVIDER_REJECTED',
      providerCode: 'INVALID_CHANNEL',
      providerStatus: 400,
      providerMessage: 'bad channel',
    });

    const unsafeDiagnostic = new XenditPayoutProvider({
      secretKey: 'secret',
      fetcher: async () => response({
        error_code: 'API_VALIDATION_ERROR',
        message: 'Invalid destination 1234567890 using xnd_development_providersecret.',
        errors: [{
          field: 'channel_properties.account_number',
          messages: ['Account 1234567890 is invalid.'],
        }],
      }, 400),
    });
    let diagnosticError: PayoutProviderError | undefined;
    try {
      await unsafeDiagnostic.createPayout(request);
    } catch (error: unknown) {
      diagnosticError = error as PayoutProviderError;
    }
    expect(diagnosticError).toMatchObject({
      code: 'PROVIDER_REJECTED',
      providerCode: 'API_VALIDATION_ERROR',
      providerStatus: 400,
    });
    expect(diagnosticError?.providerMessage).toContain('channel_properties.account_number');
    expect(diagnosticError?.providerMessage).not.toContain('1234567890');
    expect(diagnosticError?.providerMessage).not.toContain('xnd_development_providersecret');

    const uncertain = new XenditPayoutProvider({
      secretKey: 'secret',
      fetcher: async () => response({ message: 'unavailable' }, 503),
    });
    await expect(uncertain.createPayout(request)).rejects.toMatchObject({
      code: 'PROVIDER_UNCERTAIN',
      providerStatus: 503,
    });

    const timedOut = new XenditPayoutProvider({
      secretKey: 'secret',
      timeoutMs: 1,
      fetcher: (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    });
    await expect(timedOut.createPayout(request)).rejects.toMatchObject({ code: 'PROVIDER_UNCERTAIN' });

    const mismatch = new XenditPayoutProvider({
      secretKey: 'secret',
      fetcher: async () => response({ id: 'xnd-mismatch', status: 'ACCEPTED', amount: 123.46, currency: 'THB' }),
    });
    await expect(mismatch.createPayout(request)).rejects.toMatchObject({ code: 'PROVIDER_UNCERTAIN' });
  });

  it('does not call Xendit without configuration', async () => {
    const provider = new XenditPayoutProvider({ secretKey: '', fetcher: async () => response({}) });

    await expect(provider.createPayout(request)).rejects.toBeInstanceOf(PayoutProviderError);
    await expect(provider.createPayout(request)).rejects.toMatchObject({ code: 'PROVIDER_CONFIGURATION' });
  });
});
