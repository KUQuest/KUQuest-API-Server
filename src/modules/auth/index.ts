export { auth } from './auth.config';
export { ALLOWED_EMAIL_DOMAIN } from './auth.constants';
export { authPlugin } from './auth.plugin';
export {
  resolveBetterAuthSession,
  type AuthenticatedSession,
  type SessionResolver,
} from './auth.session';
export { assertTrustedBrowserOrigin, CsrfError } from './auth.csrf';
export {
  AuthenticationError,
  requireAuthenticatedUserId,
  requireTrustedMutationUserId,
} from './auth.request';
export { assertAllowedEmail, isAllowedEmail } from './auth.policy';
export type { AuthSession } from './auth.config';
