import {
  ProviderEventError,
  normalizePayoutOutcomeStatus,
  parsePayoutProviderEvent,
} from '@/modules/payout';
import { positiveSatang } from '@/modules/wallet';

import { describe, expect, it } from 'bun:test';

describe('Payout Provider event parsing', () => {
  it('converts Xendit THB payout facts to satang', () => {
    const event = parsePayoutProviderEvent(JSON.stringify({
      event: 'v3_payout.succeeded',
      api_version: '2025-09-01',
      data: {
        payout_id: 'po-123',
        reference_id: 'payout:payout-123',
        status: 'SUCCEEDED',
        source_currency: 'THB',
        source_amount: 123.45,
        fee: 0.1,
        tax: 0.05,
        updated: '2026-08-27T00:01:00.000Z',
      },
    }), new Date('2026-08-27T00:00:00.000Z'));

    expect(event).toMatchObject({
      providerEventId: 'derived:v3_payout.succeeded:po-123:COMPLETED',
      eventType: 'v3_payout.succeeded',
      internalReference: 'payout:payout-123',
      providerReference: 'po-123',
      providerApiVersion: '2025-09-01',
      providerStatus: 'SUCCEEDED',
      normalizedStatus: 'COMPLETED',
      providerAmountSatang: 12_345,
      actualFeeSatang: 10,
      actualTaxSatang: 5,
      actualDebitSatang: 12_360,
    });
    expect(event.providerOccurredAt).toEqual(new Date('2026-08-27T00:01:00.000Z'));
  });

  it('normalizes pending, failure, and cancellation outcomes', () => {
    expect(normalizePayoutOutcomeStatus('REQUESTED')).toBe('PENDING');
    expect(normalizePayoutOutcomeStatus('FAILED')).toBe('FAILED');
    expect(normalizePayoutOutcomeStatus('CANCELLED')).toBe('CANCELLED');
    expect(normalizePayoutOutcomeStatus('REVERSED')).toBe('FAILED');
  });

  it('requires payout amount arithmetic to be exact', () => {
    expect(() => parsePayoutProviderEvent(JSON.stringify({
      event: 'v3_payout.succeeded',
      data: {
        payout_id: 'po-mismatch',
        reference_id: 'payout:mismatch',
        status: 'SUCCEEDED',
        source_amount: 1,
        fee: 0.1,
        tax: 0.05,
        actual_debit: 1.2,
      },
    }))).toThrow(ProviderEventError);
  });

  it('treats an integral Xendit amount as whole THB', () => {
    const event = parsePayoutProviderEvent(JSON.stringify({
      event: 'v3_payout.succeeded',
      data: {
        payout_id: 'po-integral',
        reference_id: 'payout:integral',
        status: 'SUCCEEDED',
        source_currency: 'THB',
        source_amount: 123,
      },
    }));

    expect(event.providerAmountSatang).toBe(positiveSatang(12_300));
  });

  it('rejects unsupported payout payloads', () => {
    expect(() => parsePayoutProviderEvent(JSON.stringify({
      event: 'v3_payout.succeeded',
      data: {
        payout_id: 'po-currency',
        reference_id: 'payout:currency',
        status: 'SUCCEEDED',
        source_currency: 'USD',
        source_amount: 100,
      },
    }))).toThrow('Provider payout currency is not supported.');
  });
});
