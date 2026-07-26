import { authGuard } from '@/modules/auth';
import { apiSuccessSchema, betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { API_V1_PREFIX } from '@/shared/api-version';

import { Elysia } from 'elysia';

import { getOwnProfile, updateOwnProfile } from './profile.controller';
import { profileBodyGuard } from './profile.guard';
import { profileResponseSchema, profileUpdateSchema } from './profile.schema';

export const profileRoute = new Elysia({
  name: 'profile-route',
  prefix: `${API_V1_PREFIX}/profile`,
})
  .use(authGuard)
  .use(profileBodyGuard)
  .get('', getOwnProfile, {
    response: responses(profileResponseSchema, 401, 404),
    detail: {
      tags: ['Profile'],
      summary: 'Get own profile',
      description: 'Returns the profile of the authenticated student.',
      operationId: 'getOwnProfile',
      security: betterAuthSecurity,
    },
  })
  .patch('', updateOwnProfile, {
    body: profileUpdateSchema,
    response: responses(apiSuccessSchema, 400, 401, 404),
    detail: {
      tags: ['Profile'],
      summary: 'Update own profile',
      description:
        'Updates the profile of the authenticated student. Fields left out keep their current value; values cannot be cleared.',
      operationId: 'updateOwnProfile',
      security: betterAuthSecurity,
    },
  });
