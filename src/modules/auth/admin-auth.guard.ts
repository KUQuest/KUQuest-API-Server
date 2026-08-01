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
  app.use(adminAuthenticationGuard).onBeforeHandle(
    { as: 'scoped' },
    ({ adminSession, set }) => {
      if (!adminSession) {
        set.status = 401;
        return apiError('UNAUTHORIZED', 'Unauthorized');
      }

      if (adminSession.user.disabledAt) {
        set.status = 403;
        return apiError('ADMIN_DISABLED', 'Admin account is disabled');
      }
    },
  );
