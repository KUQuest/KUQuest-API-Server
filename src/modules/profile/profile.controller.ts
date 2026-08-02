import type { AuthedContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';

import type { Static } from 'elysia';

import type {
  avatarUploadSchema,
  profileResponseSchema,
  profileUpdateSchema,
} from './profile.schema';
import {
  getPreviousAvatarFile,
  getProfile,
  markAvatarDeleted,
  replaceStudentAvatar,
  updateProfile,
} from './profile.service';
import {
  AvatarTooLargeError,
  AvatarUploadError,
  avatarStorage,
  UnsupportedAvatarTypeError,
} from './profile.storage';

type Profile = Static<typeof profileResponseSchema>['data'];

type StoredProfileAvatar = NonNullable<Awaited<ReturnType<typeof getProfile>>>['avatar'];

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
  }
};

const userNotFound = (set: AuthedContext['set']) => {
  set.status = 404;

  return apiError('USER_NOT_FOUND', 'User not found');
};


const describeAvatar = (avatar: StoredProfileAvatar): Profile['avatar'] => {
  if (!avatar) return null;

  try {
    return { fileId: avatar.fileId, url: avatarStorage.linkFor(avatar) };
  } catch (error) {
    console.error('Building the avatar link failed', error);

    return null;
  }
};

export const getOwnProfile = async ({
  session,
  set,
}: AuthedContext): Promise<ApiResponse<Profile>> => {
  const profile = await getProfile(session.user.id);

  if (!profile) return userNotFound(set);

  const { avatar, ...rest } = profile;

  return apiSuccess({ ...rest, avatar: describeAvatar(avatar) });
};

export const updateOwnProfile = async ({
  session,
  body,
  set,
}: AuthedContext & { body: Static<typeof profileUpdateSchema> }): Promise<ApiResponse> => {
  const outcome = await updateProfile(session.user.id, body);

  if (outcome === 'student-not-found') return userNotFound(set);

  if (outcome === 'major-not-found') {
    set.status = 400;
    return apiError('MAJOR_NOT_FOUND', 'Major not found');
  }

  return apiSuccess();
};

export const setAvatar = async ({
  body,
  session,
  set,
}: AuthedContext & { body: Static<typeof avatarUploadSchema> }): Promise<
  ApiResponse<{ fileId: string }>
> => {
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
