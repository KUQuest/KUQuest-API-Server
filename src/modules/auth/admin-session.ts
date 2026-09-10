import { Elysia } from 'elysia';

import { adminAuth } from './admin-auth.config';
import { auth } from './auth.config';

export const adminSessionResolver = new Elysia({ name: 'admin-session-resolver' })
  .derive({ as: 'scoped' }, async ({ request }) => {
    const [adminSession, memberSession] = await Promise.all([
      adminAuth.api.getSession({ headers: request.headers }),
      auth.api.getSession({ headers: request.headers }),
    ]);
    return { adminSession, memberSession };
  });
