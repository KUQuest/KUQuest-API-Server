import { env } from '@/config/env';

import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const aesAlgorithm = 'aes-256-gcm';
const nonceBytes = 12;
const authTagBytes = 16;

export type PayoutDestinationKeyMaterial = string | Uint8Array;

export type PayoutDestinationEncryptedSecret = {
  keyVersion: string;
  nonce: string;
  ciphertext: string;
  authTag: string;
};

export type PayoutDestinationEncryptionErrorCode =
  | 'PAYOUT_DESTINATION_KEY_UNAVAILABLE'
  | 'PAYOUT_DESTINATION_KEY_VERSION_UNKNOWN'
  | 'PAYOUT_DESTINATION_AUTHENTICATION_FAILED'
  | 'PAYOUT_DESTINATION_ENCRYPTION_FAILED';

export class PayoutDestinationEncryptionError extends Error {
  readonly code: PayoutDestinationEncryptionErrorCode;

  constructor(code: PayoutDestinationEncryptionErrorCode, message: string) {
    super(message);
    this.name = 'PayoutDestinationEncryptionError';
    this.code = code;
  }
}

export type PayoutDestinationEncryption = {
  encrypt: (plaintext: string) => PayoutDestinationEncryptedSecret;
  decrypt: (encrypted: PayoutDestinationEncryptedSecret) => string;
};

export type PayoutDestinationEncryptionOptions = {
  activeKeyVersion?: string;
  keys?: Readonly<Record<string, PayoutDestinationKeyMaterial>>;
};

const keyBytes = (material: PayoutDestinationKeyMaterial): Buffer => {
  const bytes = material instanceof Uint8Array
    ? Buffer.from(material)
    : material.length === 32
      ? Buffer.from(material, 'utf8')
      : /^[0-9a-f]{64}$/i.test(material)
        ? Buffer.from(material, 'hex')
        : Buffer.from(material, 'base64url');

  if (bytes.length !== 32) {
    throw new PayoutDestinationEncryptionError(
      'PAYOUT_DESTINATION_KEY_UNAVAILABLE',
      'Payout Destination encryption key must contain 32 bytes.',
    );
  }

  return bytes;
};

const keyFor = (
  keys: ReadonlyMap<string, PayoutDestinationKeyMaterial>,
  version: string,
): Buffer => {
  const material = keys.get(version);
  if (material === undefined) {
    throw new PayoutDestinationEncryptionError(
      'PAYOUT_DESTINATION_KEY_VERSION_UNKNOWN',
      'Payout Destination encryption key version is not available.',
    );
  }

  return keyBytes(material);
};

export const createPayoutDestinationEncryption = (
  options: PayoutDestinationEncryptionOptions = {},
): PayoutDestinationEncryption => {
  const activeKeyVersion = options.activeKeyVersion
    ?? env.payoutDestinationEncryptionKeyVersion;
  const keys = new Map<string, PayoutDestinationKeyMaterial>(Object.entries(options.keys ?? {}));

  if (options.keys === undefined && env.payoutDestinationEncryptionKey) {
    keys.set(activeKeyVersion, env.payoutDestinationEncryptionKey);
  }

  return {
    encrypt: (plaintext) => {
      let key: Buffer;
      try {
        key = keyFor(keys, activeKeyVersion);
      } catch (error) {
        if (error instanceof PayoutDestinationEncryptionError) {
          if (error.code === 'PAYOUT_DESTINATION_KEY_VERSION_UNKNOWN') {
            throw new PayoutDestinationEncryptionError(
              'PAYOUT_DESTINATION_KEY_UNAVAILABLE',
              'Payout Destination encryption key is not configured.',
            );
          }
          throw error;
        }
        throw new PayoutDestinationEncryptionError(
          'PAYOUT_DESTINATION_KEY_UNAVAILABLE',
          'Payout Destination encryption key is not configured.',
        );
      }

      try {
        const nonce = randomBytes(nonceBytes);
        const cipher = createCipheriv(aesAlgorithm, key, nonce);
        const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

        return {
          keyVersion: activeKeyVersion,
          nonce: nonce.toString('base64url'),
          ciphertext: ciphertext.toString('base64url'),
          authTag: cipher.getAuthTag().toString('base64url'),
        };
      } catch {
        throw new PayoutDestinationEncryptionError(
          'PAYOUT_DESTINATION_ENCRYPTION_FAILED',
          'Payout Destination encryption failed.',
        );
      }
    },
    decrypt: (encrypted) => {
      const key = keyFor(keys, encrypted.keyVersion);

      try {
        const nonce = Buffer.from(encrypted.nonce, 'base64url');
        const ciphertext = Buffer.from(encrypted.ciphertext, 'base64url');
        const authTag = Buffer.from(encrypted.authTag, 'base64url');

        if (
          nonce.length !== nonceBytes ||
          ciphertext.length === 0 ||
          authTag.length !== authTagBytes
        ) {
          throw new Error('Invalid encrypted secret envelope.');
        }

        const decipher = createDecipheriv(aesAlgorithm, key, nonce);
        decipher.setAuthTag(authTag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      } catch {
        throw new PayoutDestinationEncryptionError(
          'PAYOUT_DESTINATION_AUTHENTICATION_FAILED',
          'Payout Destination authentication failed.',
        );
      }
    },
  };
};
