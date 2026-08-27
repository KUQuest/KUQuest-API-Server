import { env } from '@/config/env';

import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { ProviderEventError } from './top-up.provider-event';

const aesAlgorithm = 'aes-256-gcm';
const nonceBytes = 12;
const authTagBytes = 16;

export type ProviderEventKeyMaterial = string | Uint8Array;

export type EncryptedProviderPayload = {
  keyVersion: string;
  nonce: string;
  ciphertext: string;
  authTag: string;
};

export type ProviderEventEncryption = {
  encrypt: (plaintext: string) => EncryptedProviderPayload;
  decrypt: (encrypted: EncryptedProviderPayload) => string;
};

export type ProviderEventEncryptionOptions = {
  activeKeyVersion?: string;
  keys?: Readonly<Record<string, ProviderEventKeyMaterial>>;
};

const keyBytes = (material: ProviderEventKeyMaterial): Buffer => {
  const bytes = material instanceof Uint8Array
    ? Buffer.from(material)
    : material.length === 32
      ? Buffer.from(material, 'utf8')
      : /^[0-9a-f]{64}$/i.test(material)
        ? Buffer.from(material, 'hex')
        : Buffer.from(material, 'base64url');

  if (bytes.length !== 32) {
    throw new ProviderEventError(
      'PROVIDER_EVENT_KEY_UNAVAILABLE',
      'Provider event encryption key must contain 32 bytes.',
    );
  }
  return bytes;
};

const createKeys = (options: ProviderEventEncryptionOptions) => {
  const activeKeyVersion = options.activeKeyVersion
    ?? env.paymentProviderEventEncryptionKeyVersion;
  const keys = new Map<string, ProviderEventKeyMaterial>(Object.entries(options.keys ?? {}));
  if (options.keys === undefined && env.paymentProviderEventEncryptionKey) {
    keys.set(activeKeyVersion, env.paymentProviderEventEncryptionKey);
  }
  return { activeKeyVersion, keys };
};

export const createProviderEventEncryption = (
  options: ProviderEventEncryptionOptions = {},
): ProviderEventEncryption => {
  const { activeKeyVersion, keys } = createKeys(options);
  const getKey = (version: string) => {
    const material = keys.get(version);
    if (material === undefined) {
      throw new ProviderEventError(
        'PROVIDER_EVENT_KEY_VERSION_UNKNOWN',
        'Provider event encryption key version is not available.',
      );
    }
    return keyBytes(material);
  };

  return {
    encrypt: (plaintext) => {
      let key: Buffer;
      try {
        key = getKey(activeKeyVersion);
      } catch (error) {
        if (error instanceof ProviderEventError && error.code === 'PROVIDER_EVENT_KEY_VERSION_UNKNOWN') {
          throw new ProviderEventError(
            'PROVIDER_EVENT_KEY_UNAVAILABLE',
            'Provider event encryption key is not configured.',
          );
        }
        throw error;
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
        throw new ProviderEventError(
          'PROVIDER_EVENT_ENCRYPTION_FAILED',
          'Provider event encryption failed.',
        );
      }
    },
    decrypt: (encrypted) => {
      const key = getKey(encrypted.keyVersion);
      try {
        const nonce = Buffer.from(encrypted.nonce, 'base64url');
        const ciphertext = Buffer.from(encrypted.ciphertext, 'base64url');
        const authTag = Buffer.from(encrypted.authTag, 'base64url');
        if (nonce.length !== nonceBytes || ciphertext.length === 0 || authTag.length !== authTagBytes) {
          throw new Error('Invalid encrypted provider payload.');
        }
        const decipher = createDecipheriv(aesAlgorithm, key, nonce);
        decipher.setAuthTag(authTag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      } catch {
        throw new ProviderEventError(
          'PROVIDER_EVENT_AUTHENTICATION_FAILED_PAYLOAD',
          'Provider event payload authentication failed.',
        );
      }
    },
  };
};
