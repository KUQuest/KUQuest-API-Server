import { authGuard } from '@/modules/auth';
import { API_V1_PREFIX } from '@/shared/api-version';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';

import { Elysia } from 'elysia';

import { setAvatar } from './profile.controller';
import {
  avatarUploadResponseSchema,
  avatarUploadSchema,
} from './profile.schema';

export const profileRoute = new Elysia({
  name: 'profile-route',
  prefix: `${API_V1_PREFIX}/profile`,
})
  .use(authGuard)
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
