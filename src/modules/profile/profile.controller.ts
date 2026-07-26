import type { AuthenticatedSession } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';

import type { Static } from 'elysia';
import type { StatusMap } from 'elysia/utils';

import type { profileUpdateSchema } from './profile.schema';
import { getProfile, majorExists, updateProfile } from './profile.service';

type AuthedContext = { session: AuthenticatedSession; set: { status?: number | keyof StatusMap } };

type Profile = NonNullable<Awaited<ReturnType<typeof getProfile>>>;

export const getOwnProfile = async ({
  session,
  set,
}: AuthedContext): Promise<ApiResponse<Profile>> => {
  const profile = await getProfile(session.user.id);

  if (!profile) {
    set.status = 404;
    return apiError('USER_NOT_FOUND', 'User not found');
  }

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

  await updateProfile(session.user.id, body);

  return apiSuccess();
};
