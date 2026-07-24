import { Elysia } from 'elysia';

import { apiError } from '@/shared/api-response';

import { auth } from './auth.config';

export const authGuard = new Elysia({ name: 'auth-guard' })
  .derive({ as: 'scoped' }, async ({ request }) => {
    const session = await auth.api.getSession({ headers: request.headers });
    return { session };
  })
  .onBeforeHandle({ as: 'scoped' }, ({ session, status }) => {
    if (!session) return status(401, apiError('UNAUTHORIZED', 'Unauthorized'));
  })
  // onBeforeHandle above guarantees session is non-null by the time a handler runs;
  // this resolve re-derives that narrowed type once, here, so no downstream
  // controller needs its own `session!` assertion.
  .resolve({ as: 'scoped' }, ({ session }) => ({
    session: session as NonNullable<typeof session>,
  }));

export type AuthenticatedSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;
