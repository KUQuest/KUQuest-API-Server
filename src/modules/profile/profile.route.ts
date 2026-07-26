import { authGuard } from '@/modules/auth';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { API_V1_PREFIX } from '@/shared/api-version';

import { Elysia } from 'elysia';

import { getOwnProfile } from './profile.controller';
import { profileResponseSchema } from './profile.schema';

export const profileRoute = new Elysia({
  name: 'profile-route',
  prefix: `${API_V1_PREFIX}/profile`,
})
  .use(authGuard)
  .get('/', getOwnProfile, {
    response: responses(profileResponseSchema, 401, 404),
    detail: {
      tags: ['Profile'],
      summary: 'Get own profile',
      description: 'Returns the profile of the authenticated student.',
      operationId: 'getOwnProfile',
      security: betterAuthSecurity,
    },
  });
