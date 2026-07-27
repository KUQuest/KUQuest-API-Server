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

const debugAvatarUpload = (message: string, details?: unknown): void => {
  if (process.env.NODE_ENV !== 'test') {
    console.info(`[avatar-upload] ${message}`, details ?? '');
  }
};

const discardUploadedAvatar = async (
  bucket: string,
  objectKey: string,
): Promise<void> => {
  try {
    await avatarStorage.delete(bucket, objectKey);
  } catch (error) {
    console.error('[avatar-upload] Compensating object deletion failed', {
      bucket,
      error,
      objectKey,
    });
    // The object is unreferenced, and cleanup must not hide the original failure.
  }
};

export const setAvatar = async ({
  body,
  session,
  set,
}: AvatarUploadContext): Promise<ApiResponse<{ fileId: string }>> => {
  let storedAvatar;

  debugAvatarUpload('Request received', {
    declaredContentType: body.avatar.type,
    sizeBytes: body.avatar.size,
    userId: session.user.id,
  });

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
      debugAvatarUpload('Student disappeared before persistence', {
        userId: session.user.id,
      });
      await discardUploadedAvatar(storedAvatar.bucket, storedAvatar.objectKey);
      set.status = 404;
      return apiError('STUDENT_NOT_FOUND', 'Student not found');
    }

    debugAvatarUpload('Database pointer updated', {
      fileId: result.fileId,
      previousFileId: result.previousFileId,
      userId: session.user.id,
    });

    if (result.previousFileId) {
      try {
        const previousFile = await getPreviousAvatarFile(
          session.user.id,
          result.previousFileId,
        );
        if (previousFile) {
          await avatarStorage.delete(previousFile.bucket, previousFile.objectKey);
          await markAvatarDeleted(session.user.id, result.previousFileId);
          debugAvatarUpload('Previous avatar cleanup completed', {
            previousFileId: result.previousFileId,
            userId: session.user.id,
          });
        } else {
          debugAvatarUpload('Previous avatar metadata was not eligible for cleanup', {
            previousFileId: result.previousFileId,
            userId: session.user.id,
          });
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
