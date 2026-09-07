import { env } from '@/config/env';
import {
  MAX_WALLET_CAPACITY_SATANG,
  positiveSatang,
  satang,
  type Satang,
} from '@/modules/wallet/wallet.money';
import type { PayoutDestinationForProvider } from '@/modules/payout-destination';

import {
  normalizePayoutOutcomeStatus,
  parsePayoutProviderEvent,
  type PayoutOutcomeStatus,
} from './payout.provider-event';

// Keep the validated Thai bank payout contract on V2. Current V3 requires
// routing types and recipient details that Payout Destination does not model.
export const XENDIT_PAYOUT_API_VERSION = '2020-02-01';

export type PayoutProviderErrorCode =
  | 'PROVIDER_CONFIGURATION'
  | 'PROVIDER_REJECTED'
  | 'PROVIDER_UNCERTAIN';

type PayoutProviderErrorDetails = {
  providerCode?: string;
  providerStatus?: number;
  providerApiVersion?: string;
  providerMessage?: string;
};

const providerDiagnosticMaxLength = 500;

export const sanitizePayoutProviderDiagnostic = (value: string) => value
  .replace(/[\r\n\t]+/g, ' ')
  .replace(/\b(?:xnd|sk|pk)_[A-Za-z0-9_-]+\b/gi, '<REDACTED>')
  .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9+/=_-]+/gi, '<REDACTED>')
  .replace(/\b(?:api[-_ ]?key|secret|token|password)\s*[:=]\s*\S+/gi, '<REDACTED>')
  .replace(/\b\d[\d\s().-]{3,}\d\b/g, '<REDACTED>')
  .replace(/\b\d{4,}\b/g, '<REDACTED>')
  .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '<REDACTED>')
  .replace(/[^\x20-\x7E]/g, '?')
  .trim()
  .slice(0, providerDiagnosticMaxLength);

export class PayoutProviderError extends Error {
  readonly code: PayoutProviderErrorCode;
  readonly providerCode?: string;
  readonly providerStatus?: number;
  readonly providerApiVersion?: string;
  readonly providerMessage?: string;

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
    this.providerMessage = details.providerMessage
      ? sanitizePayoutProviderDiagnostic(details.providerMessage) || undefined
      : undefined;
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

export type OutboundPayoutStatusRequest = {
  providerReference: string | null;
  internalReference: string;
  expectedPrincipalSatang: Satang;
  maximumDebitSatang: Satang;
};

export type OutboundPayoutStatusResponse = {
  providerReference: string;
  providerStatus: string;
  normalizedStatus: PayoutOutcomeStatus;
  providerAmountSatang: Satang | null;
  actualFeeSatang: Satang | null;
  actualTaxSatang: Satang | null;
  actualDebitSatang: Satang | null;
  providerApiVersion: string;
  occurredAt: Date;
};

export interface OutboundPayoutProvider {
  createPayout(input: OutboundPayoutRequest): Promise<OutboundPayoutResponse>;
}

export interface OutboundPayoutReconciliationProvider {
  getPayoutStatus(input: OutboundPayoutStatusRequest): Promise<OutboundPayoutStatusResponse>;
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

const providerValidationSummary = (value: unknown) => {
  if (!Array.isArray(value)) return null;
  const entries = value.slice(0, 5).map(asObject).filter((entry): entry is JsonObject => entry !== null);
  const summary = entries.map((entry) => {
    const field = asText(entry.field);
    const messages = [
      ...(Array.isArray(entry.messages) ? entry.messages.map(asText).filter((message): message is string => message !== null) : []),
      asText(entry.message),
    ].filter((message): message is string => message !== null);
    return [field, messages.join(', ')].filter((part): part is string => part !== null && part.length > 0).join(': ');
  }).filter((entry) => entry.length > 0);
  return summary.length > 0 ? summary.join('; ') : null;
};

const providerErrorDetails = (payload: JsonObject | null) => {
  const providerCode = [asText(payload?.error_code), asText(payload?.code)]
    .find((value): value is string => value !== null && /^[A-Z][A-Z_]{0,63}$/.test(value));
  const providerMessage = sanitizePayoutProviderDiagnostic([
    asText(payload?.message),
    asText(payload?.error_message),
    providerValidationSummary(payload?.errors),
  ].filter((value): value is string => value !== null).join(' '));
  return {
    providerCode,
    providerMessage: providerMessage || undefined,
  };
};

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

const xenditChannelCodeByBankCode: Record<string, string> = {
  BAAC: 'TH_BAA',
  BAY: 'TH_BAY',
  BBL: 'TH_BBL',
  CIMBT: 'TH_CIMB',
  EXIM: 'TH_EXIM',
  GHB: 'TH_GHB',
  GSB: 'TH_GSB',
  ICBC: 'TH_ICBC',
  KBANK: 'TH_KKB',
  KKP: 'TH_KNB',
  KTB: 'TH_KTB',
  LHBANK: 'TH_LHB',
  SCB: 'TH_SCB',
  TISCO: 'TH_TISCO',
  TTB: 'TH_TTB',
  UOBT: 'TH_UOB',
  PROMPTPAY: 'PROMPTPAY',
};

const xenditChannelCode = (destination: PayoutDestinationForProvider): string => {
  const channelCode = xenditChannelCodeByBankCode[destination.bankCode];
  if (!channelCode) {
    throw new PayoutProviderError('PROVIDER_CONFIGURATION', 'Payout Destination bank is not configured.');
  }
  return channelCode;
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
      const channelCode = xenditChannelCode(input.destination);
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
          channel_code: channelCode,
          channel_properties: {
            account_number: destinationValue,
            account_holder_name: input.destination.accountHolderName,
          },
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

  private async requestStatus(input: OutboundPayoutStatusRequest): Promise<JsonObject> {
    if (!this.secretKey) throw this.error('PROVIDER_CONFIGURATION', 'Xendit is not configured.');
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw this.error('PROVIDER_CONFIGURATION', 'Xendit timeout is not configured correctly.');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      const endpoint = input.providerReference
        ? `/v3/payouts/${encodeURIComponent(input.providerReference)}`
        : `/v3/payouts?reference_id=${encodeURIComponent(input.internalReference)}&limit=2`;
      response = await this.fetcher(`${this.baseUrl}${endpoint}`, {
        method: 'GET',
        headers: {
          authorization: `Basic ${btoa(`${this.secretKey}:`)}`,
          'api-version': this.apiVersion,
        },
        signal: controller.signal,
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
      throw this.error('PROVIDER_UNCERTAIN', 'Xendit Payout reconciliation is uncertain.', {
        ...details,
        providerStatus: response.status,
      });
    }
    if (!payload) throw this.error('PROVIDER_UNCERTAIN', 'Xendit returned an invalid Payout status.');

    if (!input.providerReference && Array.isArray(payload.data)) {
      const matches = payload.data.map(asObject).filter((value): value is JsonObject => value !== null);
      if (matches.length !== 1) {
        throw this.error('PROVIDER_UNCERTAIN', 'Xendit did not return one Payout for the internal reference.');
      }
      return matches[0]!;
    }
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
    const channelCode = xenditChannelCode(input.destination);
    if (
      payload.channel_code !== undefined
      && payload.channel_code !== channelCode
    ) {
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

  async getPayoutStatus(
    input: OutboundPayoutStatusRequest,
  ): Promise<OutboundPayoutStatusResponse> {
    const payload = await this.requestStatus(input);
    const providerStatus = asText(payload.status);
    if (!providerStatus) throw this.error('PROVIDER_UNCERTAIN', 'Xendit returned an incomplete Payout status.');
    const normalizedStatus = normalizePayoutOutcomeStatus(providerStatus);
    const eventType = normalizedStatus === 'COMPLETED'
      ? 'v3_payout.succeeded'
      : normalizedStatus === 'CANCELLED'
        ? 'v3_payout.failed'
        : normalizedStatus === 'FAILED'
          ? 'v3_payout.failed'
          : 'v3_payout.pending_compliance';
    let parsed;
    try {
      parsed = parsePayoutProviderEvent(JSON.stringify({
        ...payload,
        event: eventType,
        api_version: payload.api_version ?? this.apiVersion,
      }));
    } catch (reason: unknown) {
      if (reason instanceof Error) {
        throw this.error('PROVIDER_UNCERTAIN', reason.message);
      }
      throw this.error('PROVIDER_UNCERTAIN', 'Xendit returned an invalid Payout status.');
    }
    if (!parsed.providerReference) {
      throw this.error('PROVIDER_UNCERTAIN', 'Xendit returned no Payout reference.');
    }
    if (input.providerReference && parsed.providerReference !== input.providerReference) {
      throw this.error('PROVIDER_UNCERTAIN', 'Xendit returned a different Payout reference.');
    }
    if (parsed.internalReference && parsed.internalReference !== input.internalReference) {
      throw this.error('PROVIDER_UNCERTAIN', 'Xendit returned a different internal reference.');
    }
    if (parsed.providerAmountSatang !== null && parsed.providerAmountSatang !== input.expectedPrincipalSatang) {
      throw this.error('PROVIDER_UNCERTAIN', 'Xendit returned a different Payout amount.');
    }
    if (parsed.actualDebitSatang !== null && parsed.actualDebitSatang > input.maximumDebitSatang) {
      throw this.error('PROVIDER_UNCERTAIN', 'Xendit returned a Payout debit above the reserve.');
    }
    return {
      providerReference: parsed.providerReference,
      providerStatus: parsed.providerStatus,
      normalizedStatus: parsed.normalizedStatus,
      providerAmountSatang: parsed.providerAmountSatang,
      actualFeeSatang: parsed.actualFeeSatang,
      actualTaxSatang: parsed.actualTaxSatang,
      actualDebitSatang: parsed.actualDebitSatang,
      providerApiVersion: parsed.providerApiVersion ?? this.apiVersion,
      occurredAt: parsed.providerOccurredAt,
    };
  }
}

export const XenditPayoutAdapter = XenditPayoutProvider;
