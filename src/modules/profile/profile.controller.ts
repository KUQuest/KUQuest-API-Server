import type { AuthenticatedSession } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';

import type { StatusMap } from 'elysia/utils';

import { getProfile } from './profile.service';

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
