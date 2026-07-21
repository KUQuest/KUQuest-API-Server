import { assertTrustedBrowserOrigin } from './auth.csrf';
import type { SessionResolver } from './auth.session';

export class AuthenticationError extends Error {
  readonly status = 401;
  readonly code = 'UNAUTHORIZED' as const;

  constructor(message = 'A valid session is required.') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export const requireAuthenticatedUserId = async (
  headers: Headers,
  resolveSession: SessionResolver,
): Promise<string> => {
  const session = await resolveSession(headers);
  if (!session?.user.id) throw new AuthenticationError();
  return session.user.id;
};

export const requireTrustedMutationUserId = async (
  headers: Headers,
  resolveSession: SessionResolver,
  trustedOrigins: readonly string[],
): Promise<string> => {
  const userId = await requireAuthenticatedUserId(headers, resolveSession);
  assertTrustedBrowserOrigin(headers, trustedOrigins);
  return userId;
};
