import { env } from '@/config/env';
import {
  MAX_WALLET_CAPACITY_SATANG,
  positiveSatang,
  type Satang,
} from '@/modules/wallet/wallet.money';

export const XENDIT_PAYMENT_REQUESTS_API_VERSION = '2024-11-11';

export type InboundPaymentProviderErrorCode =
  | 'PROVIDER_CONFIGURATION'
  | 'PROVIDER_REJECTED'
  | 'PROVIDER_UNCERTAIN';

export class InboundPaymentProviderError extends Error {
  readonly code: InboundPaymentProviderErrorCode;
  readonly providerCode?: string;
  readonly providerStatus?: number;

  constructor(
    code: InboundPaymentProviderErrorCode,
    message: string,
    details: { providerCode?: string; providerStatus?: number } = {},
  ) {
    super(message);
    this.name = 'InboundPaymentProviderError';
    this.code = code;
    this.providerCode = details.providerCode;
    this.providerStatus = details.providerStatus;
  }
}

export type InboundPaymentRequest = {
  internalReference: string;
  paymentTotalSatang: Satang;
  expiresAt: Date;
};

export type InboundPaymentResponse = {
  providerReference: string;
  providerStatus: string;
  providerAmountSatang: Satang;
  providerApiVersion: string;
  providerChannelCode: string;
  qrPayload: string;
  qrExpiresAt: Date;
};

export interface InboundPaymentProvider {
  createPayment(input: InboundPaymentRequest): Promise<InboundPaymentResponse>;
}

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type XenditPromptPayProviderOptions = {
  secretKey?: string;
  baseUrl?: string;
  apiVersion?: string;
  timeoutMs?: number;
  fetcher?: Fetcher;
};

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
);

const asText = (value: unknown): string | null => (
  typeof value === 'string' && value.length > 0 ? value : null
);

const toThb = (amountSatang: Satang): number => Number((amountSatang / 100).toFixed(2));

const fromThb = (value: unknown): Satang => {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(text)) {
    throw new InboundPaymentProviderError(
      'PROVIDER_UNCERTAIN',
      'Xendit returned an invalid payment amount.',
    );
  }
  const [baht, satangPart = ''] = text.split('.');
  const amount = Number(baht) * 100 + Number(satangPart.padEnd(2, '0') || 0);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_WALLET_CAPACITY_SATANG) {
    throw new InboundPaymentProviderError(
      'PROVIDER_UNCERTAIN',
      'Xendit returned an out-of-range payment amount.',
    );
  }
  return positiveSatang(amount);
};

const providerErrorDetails = (payload: JsonObject | null) => ({
  providerCode: asText(payload?.error_code) ?? asText(payload?.code) ?? undefined,
});

const responseMessage = (payload: JsonObject | null) => (
  asText(payload?.message) ?? asText(payload?.error_message) ?? 'Xendit rejected the payment request.'
);

const responseAction = (payload: JsonObject): string | null => {
  if (!Array.isArray(payload.actions)) return null;
  for (const action of payload.actions) {
    const object = asObject(action);
    if (object?.descriptor === 'QR_STRING') return asText(object.value);
  }
  return null;
};

export class XenditPromptPayProvider implements InboundPaymentProvider {
  private readonly secretKey: string | undefined;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly timeoutMs: number;
  private readonly fetcher: Fetcher;

  constructor(options: XenditPromptPayProviderOptions = {}) {
    this.secretKey = options.secretKey ?? env.xenditSecretKey;
    this.baseUrl = (options.baseUrl ?? process.env.XENDIT_API_BASE_URL ?? 'https://api.xendit.co').replace(/\/+$/, '');
    this.apiVersion = options.apiVersion ?? process.env.XENDIT_API_VERSION ?? XENDIT_PAYMENT_REQUESTS_API_VERSION;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetcher = options.fetcher ?? globalThis.fetch;
  }

  private async request(input: InboundPaymentRequest): Promise<JsonObject> {
    if (!this.secretKey) {
      throw new InboundPaymentProviderError(
        'PROVIDER_CONFIGURATION',
        'Xendit is not configured.',
      );
    }
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new InboundPaymentProviderError(
        'PROVIDER_CONFIGURATION',
        'Xendit timeout is not configured correctly.',
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/v3/payment_requests`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${btoa(`${this.secretKey}:`)}`,
          'content-type': 'application/json',
          'api-version': this.apiVersion,
          'idempotency-key': input.internalReference,
        },
        signal: controller.signal,
        body: JSON.stringify({
          reference_id: input.internalReference,
          type: 'PAY',
          country: 'TH',
          currency: 'THB',
          request_amount: toThb(input.paymentTotalSatang),
          capture_method: 'AUTOMATIC',
          channel_code: 'QRPROMPTPAY',
          channel_properties: {
            expires_at: input.expiresAt.toISOString(),
            qr_string_type: 'DYNAMIC',
          },
          description: 'KUQuest Top-up',
          metadata: { kuquest_reference: input.internalReference },
        }),
      });
    } catch {
      throw new InboundPaymentProviderError(
        'PROVIDER_UNCERTAIN',
        'Xendit did not return a response.',
      );
    } finally {
      clearTimeout(timeout);
    }

    let payload: JsonObject | null = null;
    try {
      payload = asObject(await response.json());
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const details = providerErrorDetails(payload);
      const uncertain = response.status >= 500 || response.status === 408 || response.status === 409 || response.status === 429;
      throw new InboundPaymentProviderError(
        uncertain ? 'PROVIDER_UNCERTAIN' : 'PROVIDER_REJECTED',
        responseMessage(payload),
        { ...details, providerStatus: response.status },
      );
    }
    if (!payload) {
      throw new InboundPaymentProviderError(
        'PROVIDER_UNCERTAIN',
        'Xendit returned an invalid response.',
      );
    }
    return payload;
  }

  async createPayment(input: InboundPaymentRequest): Promise<InboundPaymentResponse> {
    const payload = await this.request(input);
    const providerReference = asText(payload.payment_request_id);
    const providerStatus = asText(payload.status);
    const qrPayload = responseAction(payload);
    if (!providerReference || !providerStatus || !qrPayload) {
      throw new InboundPaymentProviderError(
        'PROVIDER_UNCERTAIN',
        'Xendit returned an incomplete PromptPay response.',
      );
    }
    if (payload.reference_id !== undefined && payload.reference_id !== input.internalReference) {
      throw new InboundPaymentProviderError(
        'PROVIDER_UNCERTAIN',
        'Xendit returned a different internal reference.',
      );
    }
    if (payload.request_amount !== undefined && fromThb(payload.request_amount) !== input.paymentTotalSatang) {
      throw new InboundPaymentProviderError(
        'PROVIDER_UNCERTAIN',
        'Xendit returned a different payment amount.',
      );
    }
    if (payload.country !== undefined && payload.country !== 'TH') {
      throw new InboundPaymentProviderError(
        'PROVIDER_UNCERTAIN',
        'Xendit returned a different payment country.',
      );
    }
    if (payload.currency !== undefined && payload.currency !== 'THB') {
      throw new InboundPaymentProviderError(
        'PROVIDER_UNCERTAIN',
        'Xendit returned a different payment currency.',
      );
    }
    if (payload.channel_code !== undefined && payload.channel_code !== 'QRPROMPTPAY') {
      throw new InboundPaymentProviderError(
        'PROVIDER_UNCERTAIN',
        'Xendit returned a different payment channel.',
      );
    }

    const channelProperties = asObject(payload.channel_properties);
    const qrExpiresAtText = asText(channelProperties?.expires_at);
    const qrExpiresAt = qrExpiresAtText ? new Date(qrExpiresAtText) : input.expiresAt;
    if (Number.isNaN(qrExpiresAt.getTime())) {
      throw new InboundPaymentProviderError(
        'PROVIDER_UNCERTAIN',
        'Xendit returned an invalid QR expiry.',
      );
    }

    return {
      providerReference,
      providerStatus,
      providerAmountSatang: payload.request_amount === undefined
        ? input.paymentTotalSatang
        : fromThb(payload.request_amount),
      providerApiVersion: this.apiVersion,
      providerChannelCode: asText(payload.channel_code) ?? 'QRPROMPTPAY',
      qrPayload,
      qrExpiresAt,
    };
  }
}

export const XenditPromptPayAdapter = XenditPromptPayProvider;
