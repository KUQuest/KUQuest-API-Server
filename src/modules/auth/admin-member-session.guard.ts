import { apiError } from '@/shared/api-response';

import { Elysia } from 'elysia';

import { auth } from './auth.config';
import { getAdminSession } from './admin-session';

export const adminMemberSessionGuard = new Elysia({ name: 'admin-member-session-guard' })
  .derive({ as: 'scoped' }, async ({ request }) => {
    const [adminSession, memberSession] = await Promise.all([
      getAdminSession(request),
      auth.api.getSession({ headers: request.headers }),
    ]);
    return { adminSession, memberSession };
  })
  .onBeforeHandle({ as: 'scoped' }, ({ adminSession, memberSession, set }) => {
    if (!adminSession && memberSession) {
      set.status = 403;
      return apiError('FORBIDDEN', 'Forbidden');
    }
  });
