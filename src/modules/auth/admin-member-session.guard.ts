import { apiError } from '@/shared/api-response';

import { Elysia } from 'elysia';

import { adminAuth } from './admin-auth.config';
import { auth } from './auth.config';

export const adminMemberSessionGuard = new Elysia({ name: 'admin-member-session-guard' })
  .derive({ as: 'scoped' }, async ({ request }) => {
    const [adminSession, memberSession] = await Promise.all([
      adminAuth.api.getSession({ headers: request.headers }),
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
