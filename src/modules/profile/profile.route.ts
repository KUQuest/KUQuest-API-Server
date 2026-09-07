import { authGuard } from '@/modules/auth';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { API_V1_PREFIX } from '@/shared/api-version';
import { rejectUnknownFields } from '@/shared/reject-unknown-fields';

import { Elysia } from 'elysia';

import {
  deleteAvatar,
  getOwnProfile,
  getPublicProfile,
  getPublicReviews,
  getReputation,
  getReviews,
  setAvatar,
  updateOwnProfile,
} from './profile.controller';
import {
  avatarUploadResponseSchema,
  avatarUploadSchema,
  publicProfileParamsSchema,
  publicProfileResponseSchema,
  profileResponseSchema,
  profileUpdateSchema,
  reputationResponseSchema,
  reviewsQuerySchema,
  reviewsResponseSchema,
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
  .get('/reputation', getReputation, {
    response: responses(reputationResponseSchema, 401),
    detail: {
      tags: ['Profile'],
      summary: 'Get own Profile Rating and completed Quest count',
      operationId: 'getProfileReputation',
      security: betterAuthSecurity,
    },
  })
  .get('/reviews', getReviews, {
    query: reviewsQuerySchema,
    response: responses(reviewsResponseSchema, 400, 401),
    detail: {
      tags: ['Profile'],
      summary: 'List own Profile Reviews',
      operationId: 'listProfileReviews',
      security: betterAuthSecurity,
    },
  })
  .get('/:userId/reviews', getPublicReviews, {
    params: publicProfileParamsSchema,
    query: reviewsQuerySchema,
    response: responses(reviewsResponseSchema, 400, 401, 404),
    detail: {
      tags: ['Profile', 'Reviews'],
      summary: 'List another Member’s Reviews',
      description: 'Returns immediately visible Reviews received by the selected Member, with bounded stable pagination.',
      operationId: 'listPublicProfileReviews',
      security: betterAuthSecurity,
    },
  })
  .get('/:userId', getPublicProfile, {
    params: publicProfileParamsSchema,
    response: responses(publicProfileResponseSchema, 400, 401, 404),
    detail: {
      tags: ['Profile'],
      summary: 'Get a public profile',
      description:
        'Returns the browsable profile of any Student, including temporary links to the avatar, portfolio images, and certificate images when available. Telephone and Student ID are excluded.',
      operationId: 'getPublicProfile',
      security: betterAuthSecurity,
    },
  })
  .patch('', updateOwnProfile, {
    body: profileUpdateSchema,
    transform: rejectUnknownFields(profileUpdateSchema),
    response: responses(profileResponseSchema, 400, 401, 404, 409),
    detail: {
      tags: ['Profile'],
      summary: 'Update own profile',
      description:
        'Updates the profile of the authenticated student. Fields left out keep their current value; values cannot be cleared.',
      operationId: 'updateOwnProfile',
      security: betterAuthSecurity,
    },
  })
  .delete('/avatar', deleteAvatar, {
    response: responses(avatarUploadResponseSchema, 401, 404),
    detail: {
      tags: ['Profile'],
      summary: 'Delete the current Student avatar',
      description: 'Removes the current avatar and tombstones its file metadata.',
      operationId: 'deleteProfileAvatar',
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
