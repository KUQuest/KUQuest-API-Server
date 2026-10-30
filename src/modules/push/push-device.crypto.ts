import { env } from '@/config/env';

import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const algorithm = 'aes-256-gcm';
const nonceLength = 12;
const authTagLength = 16;

export type EncryptedPushDeviceToken = {
  keyVersion: string;
  nonce: string;
  ciphertext: string;
  authTag: string;
};

export class PushDeviceEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushDeviceEncryptionError';
  }
}

const readKeyBytes = (key: string | undefined): Buffer => {
  if (!key) {
    throw new PushDeviceEncryptionError('Push Device encryption key is not configured.');
  }

  const bytes = /^[0-9a-f]{64}$/i.test(key)
    ? Buffer.from(key, 'hex')
    : Buffer.from(key, 'base64url');
  if (bytes.length !== 32) {
    throw new PushDeviceEncryptionError('Push Device encryption key must contain 32 bytes.');
  }
  return bytes;
};

export const hashPushDeviceToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

export const createPushDeviceEncryption = (options?: { key?: string; keyVersion?: string }) => {
  const key = readKeyBytes(
    options?.key ?? process.env.PUSH_DEVICE_ENCRYPTION_KEY ?? env.pushDeviceEncryptionKey
  );
  const keyVersion =
    options?.keyVersion ??
    process.env.PUSH_DEVICE_ENCRYPTION_KEY_VERSION ??
    env.pushDeviceEncryptionKeyVersion;

  return {
    encrypt: (token: string): EncryptedPushDeviceToken => {
      const nonce = randomBytes(nonceLength);
      const cipher = createCipheriv(algorithm, key, nonce);
      const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
      return {
        keyVersion,
        nonce: nonce.toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
        authTag: cipher.getAuthTag().toString('base64url'),
      };
    },
    decrypt: (encrypted: EncryptedPushDeviceToken): string => {
      if (encrypted.keyVersion !== keyVersion) {
        throw new PushDeviceEncryptionError('Push Device encryption key version is not available.');
      }
      try {
        const nonce = Buffer.from(encrypted.nonce, 'base64url');
        const ciphertext = Buffer.from(encrypted.ciphertext, 'base64url');
        const authTag = Buffer.from(encrypted.authTag, 'base64url');
        if (
          nonce.length !== nonceLength ||
          ciphertext.length === 0 ||
          authTag.length !== authTagLength
        ) {
          throw new Error('Invalid encrypted Push Device token.');
        }
        const decipher = createDecipheriv(algorithm, key, nonce);
        decipher.setAuthTag(authTag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      } catch {
        throw new PushDeviceEncryptionError('Push Device token authentication failed.');
      }
    },
  };
};
