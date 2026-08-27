import {
  createPayoutDestinationEncryption,
  type PayoutDestinationEncryptedSecret,
} from '@/modules/payout-destination';

import { describe, expect, it } from 'bun:test';

const keyV1 = 'a'.repeat(32);
const keyV2 = 'b'.repeat(32);

const encryption = createPayoutDestinationEncryption({
  activeKeyVersion: 'v1',
  keys: { v1: keyV1, v2: keyV2 },
});

describe('Payout Destination encryption', () => {
  it('encrypts and decrypts a secret with a versioned AES-256-GCM envelope', () => {
    const encrypted = encryption.encrypt('1234567890');

    expect(encrypted.keyVersion).toBe('v1');
    expect(encrypted.nonce).not.toHaveLength(0);
    expect(encrypted.ciphertext).not.toContain('1234567890');
    expect(encrypted.authTag).not.toHaveLength(0);
    expect(encryption.decrypt(encrypted)).toBe('1234567890');
  });

  it('uses a fresh nonce for every encryption', () => {
    const first = encryption.encrypt('same secret');
    const second = encryption.encrypt('same secret');

    expect(second.nonce).not.toBe(first.nonce);
    expect(second.ciphertext).not.toBe(first.ciphertext);
  });

  it('decrypts an older key version while encrypting with the active version', () => {
    const oldSecret = encryption.encrypt('old secret');
    const rotated = createPayoutDestinationEncryption({
      activeKeyVersion: 'v2',
      keys: { v1: keyV1, v2: keyV2 },
    });

    expect(rotated.encrypt('new secret').keyVersion).toBe('v2');
    expect(rotated.decrypt(oldSecret)).toBe('old secret');
  });

  it('rejects an unknown key version without exposing secret data', () => {
    const encrypted: PayoutDestinationEncryptedSecret = {
      ...encryption.encrypt('1234567890'),
      keyVersion: 'missing',
    };

    expect(() => encryption.decrypt(encrypted)).toThrowError(
      expect.objectContaining({ code: 'PAYOUT_DESTINATION_KEY_VERSION_UNKNOWN' }),
    );
  });

  it('reports authentication failure when the ciphertext is tampered with', () => {
    const encrypted = encryption.encrypt('1234567890');
    const tampered: PayoutDestinationEncryptedSecret = {
      ...encrypted,
      ciphertext: `${encrypted.ciphertext[0] === 'A' ? 'B' : 'A'}${encrypted.ciphertext.slice(1)}`,
    };

    expect(() => encryption.decrypt(tampered)).toThrowError(
      expect.objectContaining({ code: 'PAYOUT_DESTINATION_AUTHENTICATION_FAILED' }),
    );
  });

  it('reports missing key configuration as a typed failure', () => {
    const unavailable = createPayoutDestinationEncryption({ activeKeyVersion: 'v1', keys: {} });

    expect(() => unavailable.encrypt('1234567890')).toThrowError(
      expect.objectContaining({ code: 'PAYOUT_DESTINATION_KEY_UNAVAILABLE' }),
    );
  });
});
