import { authGuard } from '@/modules/auth';
import { apiSuccessSchema, betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { API_V1_PREFIX } from '@/shared/api-version';
import { rejectUnknownFields } from '@/shared/reject-unknown-fields';

import { Elysia } from 'elysia';

import { getOwnProfile, setAvatar, updateOwnProfile } from './profile.controller';
import {
  avatarUploadResponseSchema,
  avatarUploadSchema,
  profileResponseSchema,
  profileUpdateSchema,
} from './profile.schema';

export const profileRoute = new Elysia({
  name: 'profile-route',
  prefix: `${API_V1_PREFIX}/profile`,
})
  .use(authGuard)
  .get('', getOwnProfile, {
    response: responses(profileResponseSchema, 401, 404),
    detail: {
      tags: ['Profile'],
      summary: 'Get own profile',
      description:
        'Returns the profile of the authenticated student, including a temporary link to the current avatar when one is set.',
      operationId: 'getOwnProfile',
      security: betterAuthSecurity,
    },
  })
  .patch('', updateOwnProfile, {
    body: profileUpdateSchema,
    transform: rejectUnknownFields(profileUpdateSchema),
    response: responses(apiSuccessSchema, 400, 401, 404),
    detail: {
      tags: ['Profile'],
      summary: 'Update own profile',
      description:
        'Updates the profile of the authenticated student. Fields left out keep their current value; values cannot be cleared.',
      operationId: 'updateOwnProfile',
      security: betterAuthSecurity,
    },
  })
  .post('/avatar', setAvatar, {
    body: avatarUploadSchema,
    type: 'multipart/form-data',
    response: responses(avatarUploadResponseSchema, 400, 401, 404, 413, 415, 502),
    detail: {
      tags: ['Profile'],
      summary: 'Set the current Student avatar',
      description:
        'Uploads a valid JPEG, PNG, or WebP avatar up to 5 MB and stores its file reference. After replacement commits, the previous object is deleted and its file metadata is retained as a tombstone.',
      operationId: 'setProfileAvatar',
      security: betterAuthSecurity,
    },
  });
