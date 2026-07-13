import { APIError } from 'better-auth/api';

import { ALLOWED_EMAIL_DOMAIN } from './auth.constants';

export const isAllowedEmail = (email: string | null | undefined): boolean => {
  if (!email) return false;

  const parts = email.toLowerCase().split('@');

  return (
    parts.length === 2 && parts[0] !== '' && parts[1] === ALLOWED_EMAIL_DOMAIN
  );
};

export const assertAllowedEmail = (email: string | null | undefined): void => {
  if (isAllowedEmail(email)) return;

  throw new APIError('FORBIDDEN', {
    code: 'EMAIL_DOMAIN_NOT_ALLOWED',
    message: `Only @${ALLOWED_EMAIL_DOMAIN} Google accounts can sign in`,
  });
};
