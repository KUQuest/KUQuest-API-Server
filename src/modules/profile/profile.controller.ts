import type { AuthenticatedSession } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';

import type { Static } from 'elysia';
import type { StatusMap } from 'elysia/utils';

import type { avatarUploadSchema } from './profile.schema';
import {
  getPreviousAvatarFile,
  markAvatarDeleted,
  replaceStudentAvatar,
} from './profile.service';
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

const discardUploadedAvatar = async (
  bucket: string,
  objectKey: string,
): Promise<void> => {
  try {
    await avatarStorage.delete(bucket, objectKey);
  } catch {
    // The object is unreferenced, and cleanup must not hide the original failure.
  }
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
      await discardUploadedAvatar(storedAvatar.bucket, storedAvatar.objectKey);
      set.status = 404;
      return apiError('STUDENT_NOT_FOUND', 'Student not found');
    }

    if (result.previousFileId) {
      try {
        const previousFile = await getPreviousAvatarFile(
          session.user.id,
          result.previousFileId,
        );
        if (previousFile) {
          await avatarStorage.delete(previousFile.bucket, previousFile.objectKey);
          await markAvatarDeleted(session.user.id, result.previousFileId);
        }
      } catch (error) {
        console.error('Previous avatar cleanup failed', error);
      }
    }

    return apiSuccess({ fileId: result.fileId });
  } catch (error) {
    await discardUploadedAvatar(storedAvatar.bucket, storedAvatar.objectKey);
    throw error;
  }
};
