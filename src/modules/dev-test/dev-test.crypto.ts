import { createHash, randomBytes } from 'node:crypto';

export const createOpaqueActorToken = (): string =>
  randomBytes(32).toString('base64url');

export const hashActorToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');
