import type { AuthedContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';

import type { Static } from 'elysia';

import type { profileResponseSchema, profileUpdateSchema } from './profile.schema';
import { getProfile, majorExists, updateProfile } from './profile.service';

type Profile = Static<typeof profileResponseSchema>['data'];

const userNotFound = (set: AuthedContext['set']) => {
  set.status = 404;

  return apiError('USER_NOT_FOUND', 'User not found');
};

export const getOwnProfile = async ({
  session,
  set,
}: AuthedContext): Promise<ApiResponse<Profile>> => {
  const profile = await getProfile(session.user.id);

  if (!profile) return userNotFound(set);

  return apiSuccess(profile);
};

export const updateOwnProfile = async ({
  session,
  body,
  set,
}: AuthedContext & { body: Static<typeof profileUpdateSchema> }): Promise<ApiResponse> => {
  if (body.majorId && !(await majorExists(body.majorId))) {
    set.status = 400;
    return apiError('MAJOR_NOT_FOUND', 'Major not found');
  }

  const updated = await updateProfile(session.user.id, body);

  if (!updated) return userNotFound(set);

  return apiSuccess();
};
