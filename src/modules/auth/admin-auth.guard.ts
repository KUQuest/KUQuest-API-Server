import { apiError } from '@/shared/api-response';

import { Elysia } from 'elysia';
import type { StatusMap } from 'elysia/utils';

import { adminAuth } from './admin-auth.config';

export type AuthenticatedAdminSession = NonNullable<
  Awaited<ReturnType<typeof adminAuth.api.getSession>>
>;

export type AdminContext = {
  admin: AuthenticatedAdminSession['user'];
  adminSession: AuthenticatedAdminSession;
  set: { status?: number | keyof StatusMap };
};

export const adminAuthenticationGuard = new Elysia({ name: 'admin-authentication-guard' })
  .derive({ as: 'scoped' }, async ({ request }) => {
    const session = await adminAuth.api.getSession({ headers: request.headers });
    return { adminSession: session };
  })
  .onBeforeHandle({ as: 'scoped' }, ({ adminSession, set }) => {
    if (!adminSession) {
      set.status = 401;
      return apiError('UNAUTHORIZED', 'Unauthorized');
    }
  })
  .resolve({ as: 'scoped' }, ({ adminSession }) => {
    const session = adminSession as NonNullable<typeof adminSession>;

    return {
      adminSession: session,
      admin: session.user,
    };
  });

export const enabledAdminGuard = (app: Elysia) =>
  app
    .use(adminAuthenticationGuard)
    // adminAuthenticationGuard's own resolve() narrows adminSession, but that
    // narrowing doesn't cross the plugin boundary here (see ADR 0001) — re-derive
    // it once rather than repeat the onBeforeHandle null check it already covers.
    .resolve({ as: 'scoped' }, ({ adminSession }) => ({
      adminSession: adminSession as NonNullable<typeof adminSession>,
    }))
    .onBeforeHandle({ as: 'scoped' }, ({ adminSession, set }) => {
      if (adminSession.user.disabledAt) {
        set.status = 403;
        return apiError('ADMIN_DISABLED', 'Admin account is disabled');
      }
    });
