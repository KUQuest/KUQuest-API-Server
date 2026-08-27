import { env } from '@/config/env';
import {
  MAX_WALLET_CAPACITY_SATANG,
  positiveSatang,
  satang,
  type Satang,
} from '@/modules/wallet/wallet.money';
import type { PayoutDestinationForProvider } from '@/modules/payout-destination';

export const XENDIT_PAYOUT_API_VERSION = '2020-02-01';

export type PayoutProviderErrorCode =
  | 'PROVIDER_CONFIGURATION'
  | 'PROVIDER_REJECTED'
  | 'PROVIDER_UNCERTAIN';

type PayoutProviderErrorDetails = {
  providerCode?: string;
  providerStatus?: number;
  providerApiVersion?: string;
};

export class PayoutProviderError extends Error {
  readonly code: PayoutProviderErrorCode;
  readonly providerCode?: string;
  readonly providerStatus?: number;
  readonly providerApiVersion?: string;

  constructor(
    code: PayoutProviderErrorCode,
    message: string,
    details: PayoutProviderErrorDetails = {},
  ) {
    super(message);
    this.name = 'PayoutProviderError';
    this.code = code;
    this.providerCode = details.providerCode;
    this.providerStatus = details.providerStatus;
    this.providerApiVersion = details.providerApiVersion;
  }
}

export type OutboundPayoutRequest = {
  internalReference: string;
  receiptSatang: Satang;
  maximumFeeSatang: Satang;
  maximumTaxSatang: Satang;
  maximumDebitSatang: Satang;
  destination: PayoutDestinationForProvider;
};

export type OutboundPayoutResponse = {
  providerReference: string;
  providerStatus: string;
  providerAmountSatang: Satang;
  actualFeeSatang: Satang;
  actualTaxSatang: Satang;
  actualDebitSatang: Satang;
  providerApiVersion: string;
};

export interface OutboundPayoutProvider {
  createPayout(input: OutboundPayoutRequest): Promise<OutboundPayoutResponse>;
}

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type XenditPayoutProviderOptions = {
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

const fromThb = (value: unknown, allowZero = false): Satang => {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(text)) {
    throw new PayoutProviderError('PROVIDER_UNCERTAIN', 'Xendit returned an invalid Payout amount.');
  }
  const [baht, satangPart = ''] = text.split('.');
  const amount = Number(baht) * 100 + Number(satangPart.padEnd(2, '0') || 0);
  if (
    !Number.isSafeInteger(amount) ||
    amount < 0 ||
    (!allowZero && amount === 0) ||
    amount > MAX_WALLET_CAPACITY_SATANG
  ) {
    throw new PayoutProviderError('PROVIDER_UNCERTAIN', 'Xendit returned an out-of-range Payout amount.');
  }
  return allowZero ? satang(amount) : positiveSatang(amount);
};

const providerErrorDetails = (payload: JsonObject | null) => ({
  providerCode: [asText(payload?.error_code), asText(payload?.code)]
    .find((value): value is string => value !== null && /^[A-Z][A-Z_]{0,63}$/.test(value)) ?? undefined,
});

const acceptedProviderStatuses = new Set([
  'ACCEPTED',
  'PENDING',
  'PROCESSING',
  'PENDING_COMPLIANCE_REVIEW',
  'REQUESTED',
  'ROUTING',
  'READY',
  'LOCKED',
]);

const rejectedProviderStatuses = new Set([
  'FAILED',
  'REJECTED',
  'CANCELLED',
  'REVERSED',
  'EXPIRED',
]);

const amountValue = (value: unknown): unknown => {
  const object = asObject(value);
  return object?.amount ?? value;
};

export class XenditPayoutProvider implements OutboundPayoutProvider {
  private readonly secretKey: string | undefined;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly timeoutMs: number;
  private readonly fetcher: Fetcher;

  constructor(options: XenditPayoutProviderOptions = {}) {
    this.secretKey = options.secretKey ?? env.xenditSecretKey;
    this.baseUrl = (options.baseUrl ?? process.env.XENDIT_API_BASE_URL ?? 'https://api.xendit.co').replace(/\/+$/, '');
    this.apiVersion = options.apiVersion ?? process.env.XENDIT_PAYOUT_API_VERSION ?? XENDIT_PAYOUT_API_VERSION;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetcher = options.fetcher ?? globalThis.fetch;
  }

  private error(
    code: PayoutProviderErrorCode,
    message: string,
    details: Omit<PayoutProviderErrorDetails, 'providerApiVersion'> = {},
  ) {
    return new PayoutProviderError(code, message, {
      ...details,
      providerApiVersion: this.apiVersion,
    });
  }

  private async request(input: OutboundPayoutRequest): Promise<JsonObject> {
    if (!this.secretKey) throw this.error('PROVIDER_CONFIGURATION', 'Xendit is not configured.');
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw this.error('PROVIDER_CONFIGURATION', 'Xendit timeout is not configured correctly.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      const destinationValue = input.destination.routingType === 'PROMPTPAY'
        ? input.destination.routingValue
        : input.destination.accountNumber;
      response = await this.fetcher(`${this.baseUrl}/v2/payouts`, {
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
          channel_code: input.destination.bankCode,
          channel_properties: { account_number: destinationValue },
          amount: toThb(input.receiptSatang),
          currency: 'THB',
          description: 'KUQuest Payout',
          metadata: { kuquest_reference: input.internalReference },
        }),
      });
    } catch {
      throw this.error('PROVIDER_UNCERTAIN', 'Xendit did not return a response.');
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
      throw this.error(
        uncertain ? 'PROVIDER_UNCERTAIN' : 'PROVIDER_REJECTED',
        uncertain ? 'Xendit Payout response is uncertain.' : 'Xendit rejected the Payout.',
        { ...details, providerStatus: response.status },
      );
    }
    if (!payload) throw this.error('PROVIDER_UNCERTAIN', 'Xendit returned an invalid response.');
    return payload;
  }

  async createPayout(input: OutboundPayoutRequest): Promise<OutboundPayoutResponse> {
    const payload = await this.request(input);
    const providerReference = asText(payload.id) ?? asText(payload.payout_id);
    const providerStatus = asText(payload.status)?.toUpperCase();
    if (providerStatus && rejectedProviderStatuses.has(providerStatus)) {
      throw this.error('PROVIDER_REJECTED', 'Xendit rejected the Payout.', {
        providerCode: providerStatus,
      });
    }
    if (!providerReference || !providerStatus || !acceptedProviderStatuses.has(providerStatus)) {
      throw this.error('PROVIDER_UNCERTAIN', 'Xendit returned an incomplete Payout response.');
    }

    const responseReference = asText(payload.reference_id) ?? asText(payload.external_id);
    if (responseReference && responseReference !== input.internalReference) {
      throw this.error('PROVIDER_UNCERTAIN', 'Xendit returned a different internal reference.');
    }
    if (payload.currency !== undefined && payload.currency !== 'THB') {
      throw this.error('PROVIDER_UNCERTAIN', 'Xendit returned a different Payout currency.');
    }
    if (payload.channel_code !== undefined && payload.channel_code !== input.destination.bankCode) {
      throw this.error('PROVIDER_UNCERTAIN', 'Xendit returned a different Payout channel.');
    }

    let providerAmountSatang: Satang;
    try {
      providerAmountSatang = fromThb(payload.amount ?? payload.source_amount);
    } catch (reason: unknown) {
      if (reason instanceof PayoutProviderError) {
        throw this.error(reason.code, reason.message, { providerCode: reason.providerCode });
      }
      throw reason;
    }
    if (providerAmountSatang !== input.receiptSatang) {
      throw this.error('PROVIDER_UNCERTAIN', 'Xendit returned a different Payout amount.');
    }

    const actualFeeSatang = payload.fee === undefined && payload.fee_amount === undefined
      ? satang(0)
      : fromThb(amountValue(payload.fee ?? payload.fee_amount), true);
    const actualTaxSatang = payload.tax === undefined && payload.tax_amount === undefined
      ? satang(0)
      : fromThb(amountValue(payload.tax ?? payload.tax_amount), true);
    const actualDebitSatang = providerAmountSatang + actualFeeSatang + actualTaxSatang;
    if (!Number.isSafeInteger(actualDebitSatang) || actualDebitSatang > MAX_WALLET_CAPACITY_SATANG) {
      throw this.error('PROVIDER_UNCERTAIN', 'Xendit returned an out-of-range Payout debit.');
    }

    return {
      providerReference,
      providerStatus,
      providerAmountSatang,
      actualFeeSatang,
      actualTaxSatang,
      actualDebitSatang: satang(actualDebitSatang),
      providerApiVersion: this.apiVersion,
    };
  }
}

export const XenditPayoutAdapter = XenditPayoutProvider;
