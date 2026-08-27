import {
  MAX_WALLET_CAPACITY_SATANG,
  positiveSatang,
  type Satang,
} from '@/modules/wallet/wallet.money';

import { createHash } from 'node:crypto';

export type TopUpOutcomeStatus = 'PENDING' | 'PAID' | 'EXPIRED' | 'FAILED';

export type ParsedTopUpProviderEvent = {
  provider: 'XENDIT';
  providerEventId: string;
  eventType: string;
  resourceType: 'TOP_UP';
  internalReference: string | null;
  providerReference: string | null;
  providerApiVersion: string;
  providerStatus: string;
  normalizedStatus: TopUpOutcomeStatus;
  providerAmountSatang: Satang | null;
  providerChannelCode: string | null;
  providerOccurredAt: Date;
  payloadHash: string;
};

export type ProviderEventErrorCode =
  | 'PROVIDER_EVENT_AUTHENTICATION_FAILED'
  | 'PROVIDER_EVENT_INVALID'
  | 'PROVIDER_EVENT_CONFLICT'
  | 'PROVIDER_EVENT_KEY_UNAVAILABLE'
  | 'PROVIDER_EVENT_KEY_VERSION_UNKNOWN'
  | 'PROVIDER_EVENT_AUTHENTICATION_FAILED_PAYLOAD'
  | 'PROVIDER_EVENT_ENCRYPTION_FAILED'
  | 'PROVIDER_EVENT_NOT_FOUND'
  | 'PROVIDER_EVENT_NOT_RETRYABLE';

export class ProviderEventError extends Error {
  readonly code: ProviderEventErrorCode;

  constructor(code: ProviderEventErrorCode, message: string) {
    super(message);
    this.name = 'ProviderEventError';
    this.code = code;
  }
}

const maxRawPayloadBytes = 1_048_576;

const asObject = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const asText = (value: unknown): string | null => (
  typeof value === 'string' && value.trim().length > 0 ? value : null
);

const firstText = (...values: unknown[]) => {
  for (const value of values) {
    const text = asText(value);
    if (text) return text;
  }
  return null;
};

export const canonicalizeProviderPayload = (value: unknown): string => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider payload contains an invalid number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeProviderPayload).join(',')}]`;
  }
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalizeProviderPayload(object[key])}`).join(',')}}`;
  }
  throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider payload contains an unsupported value.');
};

export const providerPayloadHash = (canonicalPayload: string): string =>
  createHash('sha256').update(canonicalPayload, 'utf8').digest('hex');

const parseProviderAmount = (value: unknown): Satang => {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(text)) {
    throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider amount is invalid.');
  }
  const [baht, satangPart = ''] = text.split('.');
  const amount = Number(baht) * 100 + Number(satangPart.padEnd(2, '0') || 0);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_WALLET_CAPACITY_SATANG) {
    throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider amount is out of range.');
  }
  return positiveSatang(amount);
};

const parseProviderDate = (value: unknown, fallback: Date): Date => {
  if (value === undefined || value === null) return fallback;
  const text = asText(value);
  if (!text) throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider event timestamp is invalid.');
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider event timestamp is invalid.');
  return date;
};

export const normalizeTopUpOutcomeStatus = (providerStatus: string): TopUpOutcomeStatus => {
  const status = providerStatus.trim().toUpperCase().replaceAll('-', '_').replaceAll(' ', '_');
  if (['SUCCEEDED', 'SUCCESS', 'PAID', 'COMPLETED', 'SETTLED'].includes(status)) return 'PAID';
  if (['EXPIRED', 'EXPIRE'].includes(status)) return 'EXPIRED';
  if (['FAILED', 'FAILURE', 'CANCELLED', 'CANCELED', 'DECLINED', 'REVERSED', 'REFUNDED', 'REFUND', 'CHARGEBACK', 'CHARGEBACKED'].includes(status)) return 'FAILED';
  return 'PENDING';
};

export const isTopUpProviderReversal = (providerStatus: string): boolean => [
  'REVERSED',
  'REFUNDED',
  'REFUND',
  'CHARGEBACK',
  'CHARGEBACKED',
].includes(providerStatus.trim().toUpperCase().replaceAll('-', '_').replaceAll(' ', '_'));

export const parseTopUpProviderEvent = (
  rawPayload: string,
  receivedAt = new Date(),
  providerEventId?: string,
): ParsedTopUpProviderEvent => {
  const rawPayloadBytes = new TextEncoder().encode(rawPayload).byteLength;
  if (rawPayloadBytes === 0 || rawPayloadBytes > maxRawPayloadBytes) {
    throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider payload is empty or too large.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPayload);
  } catch {
    throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider payload is not valid JSON.');
  }

  const payload = asObject(parsed);
  if (!payload) throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider payload must be a JSON object.');
  const data = asObject(payload.data) ?? payload;
  const canonicalPayload = canonicalizeProviderPayload(parsed);
  const payloadHash = providerPayloadHash(canonicalPayload);
  const providerStatus = firstText(data.status, payload.status);
  if (!providerStatus) throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider status is required.');

  const metadata = asObject(data.metadata) ?? asObject(payload.metadata);
  const internalReference = firstText(
    data.reference_id,
    data.internal_reference,
    metadata?.kuquest_reference,
    payload.reference_id,
    payload.internal_reference,
  );
  const providerReference = firstText(
    data.payment_request_id,
    data.payment_id,
    data.id,
    payload.payment_request_id,
    payload.payment_id,
  );
  if (!internalReference && !providerReference) {
    throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider event has no payment reference.');
  }

  const providerAmount = data.request_amount ?? data.amount ?? data.paid_amount ?? payload.request_amount ?? payload.amount;
  const normalizedStatus = normalizeTopUpOutcomeStatus(providerStatus);
  const providerAmountSatang = providerAmount === undefined || providerAmount === null
    ? null
    : parseProviderAmount(providerAmount);
  if (normalizedStatus === 'PAID' && providerAmountSatang === null) {
    throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'A paid Provider event must include an amount.');
  }

  const resolvedProviderEventId = firstText(providerEventId, payload.event_id, payload.id, data.event_id);
  if (!resolvedProviderEventId) {
    throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider event identifier is required.');
  }
  const eventType = firstText(payload.event, payload.event_type, data.event_type) ?? 'payment.status';
  const providerApiVersion = firstText(data.api_version, payload.api_version) ?? '2024-11-11';
  const providerChannelCode = firstText(data.channel_code, payload.channel_code);
  const providerOccurredAt = parseProviderDate(
    data.updated_at ?? data.updated ?? data.created_at ?? data.created ?? payload.created_at ?? payload.created,
    receivedAt,
  );

  return {
    provider: 'XENDIT',
    providerEventId: resolvedProviderEventId,
    eventType,
    resourceType: 'TOP_UP',
    internalReference,
    providerReference,
    providerApiVersion,
    providerStatus,
    normalizedStatus,
    providerAmountSatang,
    providerChannelCode,
    providerOccurredAt,
    payloadHash,
  };
};
