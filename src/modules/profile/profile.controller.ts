import type { AuthenticatedSession } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';

import type { Static } from 'elysia';
import type { StatusMap } from 'elysia/utils';

import type { avatarUploadSchema } from './profile.schema';
import { replaceStudentAvatar } from './profile.service';
import {
  AvatarTooLargeError,
  AvatarUploadError,
  avatarStorage,
  UnsupportedAvatarTypeError,
} from './profile.storage';

type AvatarUploadContext = {
  body: Static<typeof avatarUploadSchema>;
  session: AuthenticatedSession;
  set: { status?: number | keyof StatusMap };
};

export const setAvatar = async ({
  body,
  session,
  set,
}: AvatarUploadContext): Promise<ApiResponse<{ fileId: string }>> => {
  let storedAvatar;

  try {
    storedAvatar = await avatarStorage.upload(session.user.id, body.avatar);
  } catch (error) {
    if (error instanceof AvatarTooLargeError) {
      set.status = 413;
      return apiError('AVATAR_TOO_LARGE', error.message);
    }
    if (error instanceof UnsupportedAvatarTypeError) {
      set.status = 415;
      return apiError('UNSUPPORTED_AVATAR_TYPE', error.message);
    }
    if (error instanceof AvatarUploadError) {
      set.status = 502;
      return apiError('AVATAR_UPLOAD_FAILED', 'Avatar upload failed');
    }
    throw error;
  }

  try {
    const result = await replaceStudentAvatar(session.user.id, storedAvatar);
    if (!result) {
      await avatarStorage.delete(storedAvatar.objectKey);
      set.status = 404;
      return apiError('STUDENT_NOT_FOUND', 'Student not found');
    }

    return apiSuccess(result);
  } catch (error) {
    await avatarStorage.delete(storedAvatar.objectKey);
    throw error;
  }
};
