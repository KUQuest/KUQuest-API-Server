import {
  ProviderEventError,
  canonicalizeProviderPayload,
  createProviderEventEncryption,
  parseTopUpProviderEvent,
  providerPayloadHash,
} from '@/modules/top-up';

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
      event: 'payment_request.succeeded',
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
      eventType: 'payment_request.succeeded',
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
