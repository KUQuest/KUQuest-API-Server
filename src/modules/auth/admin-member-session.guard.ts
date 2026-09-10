import { apiError } from '@/shared/api-response';

import { Elysia } from 'elysia';

import { adminSessionResolver } from './admin-session';

export const adminMemberSessionGuard = (app: Elysia) =>
  app
    .use(adminSessionResolver)
    .onBeforeHandle({ as: 'scoped' }, ({ adminSession, memberSession, set }) => {
      if (!adminSession && memberSession) {
        set.status = 403;
        return apiError('FORBIDDEN', 'Forbidden');
      }
    });
