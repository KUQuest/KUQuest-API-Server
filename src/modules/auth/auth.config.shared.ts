import { env } from '@/config/env';

export const configurationPlaceholder = (name: string): string =>
  `missing-${name}-configure-it-before-starting-the-server`;

export const defaultCookieAttributes = {
  sameSite: 'none',
  secure: true,
  httpOnly: true,
} as const;

export const getTrustedOrigins = (includeExpoOrigin = false): string[] => [
  env.cmsOrigin || 'http://localhost:5000',
  ...(includeExpoOrigin ? ['kuquest://'] : []),
  'http://localhost:3000',
];
