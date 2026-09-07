import { env } from '@/config/env';

export const configurationPlaceholder = (name: string): string =>
  `missing-${name}-configure-it-before-starting-the-server`;

const useSecureCookies = env.betterAuthUrl?.startsWith('https://') ?? false;

export const defaultCookieAttributes = {
  sameSite: useSecureCookies ? 'none' : 'lax',
  secure: useSecureCookies,
  httpOnly: true,
} as const;

export const getTrustedOrigins = (includeExpoOrigin = false): string[] => [
  env.cmsOrigin || 'http://localhost:5000',
  ...(includeExpoOrigin ? ['kuquestmobile://'] : []),
  'http://localhost:3000',
];
