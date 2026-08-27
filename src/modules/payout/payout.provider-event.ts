import {
  MAX_WALLET_CAPACITY_SATANG,
  positiveSatang,
  satang,
  type Satang,
} from '@/modules/wallet/wallet.money';
import {
  canonicalizeProviderPayload,
  ProviderEventError,
  providerPayloadHash,
} from '@/modules/top-up/top-up.provider-event';

export type PayoutOutcomeStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export type ParsedPayoutProviderEvent = {
  provider: 'XENDIT';
  providerEventId: string;
  eventType: string;
  resourceType: 'PAYOUT';
  internalReference: string | null;
  providerReference: string | null;
  providerApiVersion: string | null;
  providerStatus: string;
  normalizedStatus: PayoutOutcomeStatus;
  providerAmountSatang: Satang | null;
  actualFeeSatang: Satang | null;
  actualTaxSatang: Satang | null;
  actualDebitSatang: Satang | null;
  providerChannelCode: string | null;
  providerOccurredAt: Date;
  payloadHash: string;
};

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

const firstDefined = (...values: unknown[]) => values.find((value) => value !== undefined && value !== null);

const parsePayoutAmount = (value: unknown, allowZero = false): Satang => {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(text)) {
    throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider payout amount is invalid.');
  }
  const [whole, fractional] = text.split('.');
  const amount = fractional === undefined
    ? Number(whole)
    : Number(whole) * 100 + Number(fractional.padEnd(2, '0'));
  if (
    !Number.isSafeInteger(amount) ||
    amount < 0 ||
    (!allowZero && amount === 0) ||
    amount > MAX_WALLET_CAPACITY_SATANG
  ) {
    throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider payout amount is out of range.');
  }
  return satang(amount);
};

const parseOptionalPayoutAmount = (value: unknown, allowZero = true): Satang | null => (
  value === undefined || value === null ? null : parsePayoutAmount(value, allowZero)
);

const parseProviderDate = (value: unknown, fallback: Date): Date => {
  if (value === undefined || value === null) return fallback;
  const text = asText(value);
  if (!text) throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider payout timestamp is invalid.');
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider payout timestamp is invalid.');
  }
  return date;
};

export const normalizePayoutOutcomeStatus = (providerStatus: string): PayoutOutcomeStatus => {
  const status = providerStatus.trim().toUpperCase().replaceAll('-', '_').replaceAll(' ', '_');
  if (['SUCCEEDED', 'SUCCESS', 'COMPLETED', 'SETTLED'].includes(status)) return 'COMPLETED';
  if (['CANCELLED', 'CANCELED'].includes(status)) return 'CANCELLED';
  if (['FAILED', 'FAILURE', 'REJECTED', 'EXPIRED', 'REVERSED', 'COMPLIANCE_REJECTED'].includes(status)) return 'FAILED';
  return 'PENDING';
};

export const isPayoutProviderReversal = (providerStatus: string, eventType?: string): boolean => (
  eventType?.toLowerCase().endsWith('.reversed') === true ||
  ['REVERSED', 'REFUNDED', 'REFUND'].includes(
    providerStatus.trim().toUpperCase().replaceAll('-', '_').replaceAll(' ', '_'),
  )
);

const supportedProviderEventTypes = new Set([
  'v3_payout.succeeded',
  'v3_payout.failed',
  'v3_payout.reversed',
  'v3_payout.rejected',
  'v3_payout.pending_compliance',
  'payout.succeeded',
  'payout.failed',
  'payout.reversed',
  'payout.rejected',
  'payout.pending_compliance',
]);

const providerAmountValue = (data: Record<string, unknown>): unknown => {
  const payoutDetails = asObject(data.payout_details);
  const value = firstDefined(
    data.source_amount,
    payoutDetails?.source_amount,
    data.amount,
    data.payout_amount,
  );
  return asObject(value)?.amount ?? value;
};

const actualAmountValue = (data: Record<string, unknown>, names: string[]): unknown => {
  const value = firstDefined(...names.map((name) => data[name]));
  return asObject(value)?.amount ?? value;
};

export const parsePayoutProviderEvent = (
  rawPayload: string,
  receivedAt = new Date(),
  providerEventId?: string,
): ParsedPayoutProviderEvent => {
  const rawPayloadBytes = new TextEncoder().encode(rawPayload).byteLength;
  if (rawPayloadBytes === 0 || rawPayloadBytes > 1_048_576) {
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
  const payloadData = asObject(payload.data);
  const data = asObject(payloadData?.data) ?? payloadData ?? payload;
  const eventType = firstText(payload.event, payload.event_type, data.event_type);
  if (!eventType || !supportedProviderEventTypes.has(eventType)) {
    throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider payout event type is not supported.');
  }
  const providerStatus = firstText(data.status, payload.status);
  if (!providerStatus) throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider payout status is required.');

  const metadata = asObject(data.metadata) ?? asObject(payload.metadata);
  const internalReference = firstText(
    data.reference_id,
    data.internal_reference,
    metadata?.kuquest_reference,
    payload.reference_id,
    payload.internal_reference,
  );
  const providerReference = firstText(
    data.payout_id,
    data.id,
    data.processor_reference,
    payload.payout_id,
    payload.id,
  );
  if (!internalReference && !providerReference) {
    throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider payout event has no payout reference.');
  }

  const sourceCurrency = firstText(data.source_currency, payload.source_currency);
  const destinationCurrency = firstText(data.destination_currency, payload.destination_currency);
  if ((sourceCurrency && sourceCurrency !== 'THB') || (destinationCurrency && destinationCurrency !== 'THB')) {
    throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider payout currency is not supported.');
  }
  const providerChannelCode = firstText(data.channel_code, payload.channel_code);
  const normalizedStatus = normalizePayoutOutcomeStatus(providerStatus);
  const providerAmountValueResult = providerAmountValue(data);
  const providerAmountSatang = parseOptionalPayoutAmount(providerAmountValueResult, false);

  let actualFeeSatang: Satang | null = null;
  let actualTaxSatang: Satang | null = null;
  let actualDebitSatang: Satang | null = null;
  if (normalizedStatus === 'COMPLETED') {
    if (providerAmountSatang === null) {
      throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'A completed Provider payout must include an amount.');
    }
    actualFeeSatang = parseOptionalPayoutAmount(actualAmountValue(data, [
      'actual_fee_satang',
      'fee_satang',
      'fee',
      'fee_amount',
      'payout_fee',
    ]));
    actualTaxSatang = parseOptionalPayoutAmount(actualAmountValue(data, [
      'actual_tax_satang',
      'tax_satang',
      'tax',
      'tax_amount',
      'payout_tax',
    ]));
    actualDebitSatang = parseOptionalPayoutAmount(actualAmountValue(data, [
      'actual_debit_satang',
      'debit_satang',
      'actual_debit',
      'total_amount_satang',
      'total_amount',
    ]));
    actualFeeSatang ??= satang(0);
    actualTaxSatang ??= satang(0);
    const derivedDebitSatang = providerAmountSatang + actualFeeSatang + actualTaxSatang;
    if (actualDebitSatang !== null && actualDebitSatang !== derivedDebitSatang) {
      throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider payout amounts do not balance.');
    }
    actualDebitSatang ??= positiveSatang(derivedDebitSatang);
  }

  const providerApiVersion = firstText(data.api_version, payload.api_version);
  const providerOccurredAt = parseProviderDate(
    data.updated ?? data.updated_at ?? data.created ?? data.created_at ?? payload.created ?? payload.created_at,
    receivedAt,
  );
  const resolvedProviderEventId = firstText(providerEventId, payload.event_id, payload.webhook_id, payload.id)
    ?? (providerReference ?? internalReference
      ? `derived:${eventType}:${providerReference ?? internalReference}:${normalizedStatus}`
      : null);
  if (!resolvedProviderEventId) {
    throw new ProviderEventError('PROVIDER_EVENT_INVALID', 'Provider payout event identifier is required.');
  }

  return {
    provider: 'XENDIT',
    providerEventId: resolvedProviderEventId,
    eventType,
    resourceType: 'PAYOUT',
    internalReference,
    providerReference,
    providerApiVersion,
    providerStatus,
    normalizedStatus,
    providerAmountSatang,
    actualFeeSatang,
    actualTaxSatang,
    actualDebitSatang,
    providerChannelCode,
    providerOccurredAt,
    payloadHash: providerPayloadHash(canonicalizeProviderPayload(parsed)),
  };
};
