import { authGuard } from '@/modules/auth';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { API_V1_PREFIX } from '@/shared/api-version';

import { Elysia, ValidationError } from 'elysia';

import { getOwnProfile, updateOwnProfile } from './profile.controller';
import {
  profileResponseSchema,
  profileUpdateResponseSchema,
  profileUpdateSchema,
  unknownProfileField,
} from './profile.schema';

export const profileRoute = new Elysia({
  name: 'profile-route',
  prefix: `${API_V1_PREFIX}/profile`,
})
  .use(authGuard)
  // Transform is the last point at which a body property the schema does not declare
  // is still visible; by validation time Elysia has already stripped it. Raising
  // Elysia's own validation error makes the rejection indistinguishable from every
  // other rejected body, including its status and error code.
  .onTransform({ as: 'scoped' }, ({ body }) => {
    if (unknownProfileField(body)) throw new ValidationError('body', profileUpdateSchema, body);
  })
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
    response: responses(profileUpdateResponseSchema, 400, 401),
    detail: {
      tags: ['Profile'],
      summary: 'Update own profile',
      description:
        'Updates the profile of the authenticated student. Fields left out keep their current value; values cannot be cleared.',
      operationId: 'updateOwnProfile',
      security: betterAuthSecurity,
    },
  });
