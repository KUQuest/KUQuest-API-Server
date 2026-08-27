import {
  ProviderEventError,
  canonicalizeProviderPayload,
  createProviderEventEncryption,
  parseTopUpProviderEvent,
  providerPayloadHash,
} from '@/modules/top-up';
import { positiveSatang } from '@/modules/wallet';

import { describe, expect, it } from 'bun:test';

describe('Top-up Provider event parsing', () => {
  it('canonicalizes payload keys before hashing', () => {
    const first = canonicalizeProviderPayload({ b: 2, a: { d: 4, c: 3 } });
    const second = canonicalizeProviderPayload({ a: { c: 3, d: 4 }, b: 2 });

    expect(first).toBe(second);
    expect(providerPayloadHash(first)).toBe(providerPayloadHash(second));
  });

  it('extracts permanent Xendit facts and preserves satang exactly', () => {
    const receivedAt = new Date('2026-08-27T00:00:00.000Z');
    const event = parseTopUpProviderEvent(JSON.stringify({
      id: 'xnd-event-1',
      event: 'payment.capture',
      api_version: '2024-11-11',
      data: {
        payment_request_id: 'pr-1',
        reference_id: 'top-up:top-up-1',
        status: 'SUCCEEDED',
        request_amount: 123.45,
        channel_code: 'QRPROMPTPAY',
        updated: '2026-08-27T00:01:00.000Z',
      },
    }), receivedAt);

    expect(event).toMatchObject({
      providerEventId: 'xnd-event-1',
      eventType: 'payment.capture',
      internalReference: 'top-up:top-up-1',
      providerReference: 'pr-1',
      providerAmountSatang: 12_345,
      providerStatus: 'SUCCEEDED',
      normalizedStatus: 'PAID',
      providerChannelCode: 'QRPROMPTPAY',
    });
    expect(event.providerOccurredAt).toEqual(new Date('2026-08-27T00:01:00.000Z'));
  });

  it('rejects a paid event without an amount', () => {
    expect(() => parseTopUpProviderEvent(JSON.stringify({
      id: 'xnd-event-2',
      data: {
        payment_request_id: 'pr-2',
        status: 'SUCCEEDED',
      },
    }))).toThrow(ProviderEventError);
  });

  it('derives a stable event identifier from a Xendit payment callback', () => {
    const event = parseTopUpProviderEvent(JSON.stringify({
      event: 'payment.capture',
      created: '2026-08-27T00:00:00.000Z',
      data: {
        payment_id: 'py-3',
        payment_request_id: 'pr-3',
        reference_id: 'top-up:top-up-3',
        status: 'SUCCEEDED',
        request_amount: 1,
        updated: '2026-08-27T00:00:00.000Z',
      },
    }));

    expect(event.providerEventId).toBe('derived:payment.capture:py-3:PAID');
  });

  it('uses captured amount instead of the requested amount', () => {
    const event = parseTopUpProviderEvent(JSON.stringify({
      event: 'payment.capture',
      data: {
        payment_id: 'py-partial',
        payment_request_id: 'pr-partial',
        reference_id: 'top-up:partial',
        status: 'SUCCEEDED',
        request_amount: 10,
        captures: [{ capture_id: 'cap-partial', capture_amount: 1 }],
      },
    }));

    expect(event.providerAmountSatang).toBe(positiveSatang(100));
  });

  it('rejects unsupported Provider event types and currencies', () => {
    expect(() => parseTopUpProviderEvent(JSON.stringify({
      event: 'refund.succeeded',
      data: {
        payment_request_id: 'pr-refund',
        reference_id: 'top-up:refund',
        status: 'SUCCEEDED',
        request_amount: 1,
      },
    }))).toThrow('Provider event type is not supported.');

    expect(() => parseTopUpProviderEvent(JSON.stringify({
      event: 'payment.capture',
      data: {
        payment_request_id: 'pr-currency',
        reference_id: 'top-up:currency',
        status: 'SUCCEEDED',
        request_amount: 1,
        currency: 'IDR',
      },
    }))).toThrow('Provider event currency is not supported.');
  });
});

describe('Provider event payload encryption', () => {
  it('encrypts and decrypts complete payloads with a versioned AES key', () => {
    const encryption = createProviderEventEncryption({
      activeKeyVersion: 'v2',
      keys: { v2: 'e'.repeat(32) },
    });
    const payload = '{"secret":"do-not-retain-in-plaintext"}';
    const encrypted = encryption.encrypt(payload);

    expect(encrypted.keyVersion).toBe('v2');
    expect(encrypted.ciphertext).not.toContain('do-not-retain-in-plaintext');
    expect(encryption.decrypt(encrypted)).toBe(payload);
  });

  it('fails closed when a payload key version is unavailable', () => {
    const encryption = createProviderEventEncryption({
      activeKeyVersion: 'v1',
      keys: { v1: 'e'.repeat(32) },
    });
    const encrypted = encryption.encrypt('payload');
    const otherKeyring = createProviderEventEncryption({
      activeKeyVersion: 'v2',
      keys: { v2: 'f'.repeat(32) },
    });

    expect(() => otherKeyring.decrypt(encrypted)).toThrow('key version is not available');
  });
});
