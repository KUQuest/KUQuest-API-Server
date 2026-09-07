import { serializeCertificate, listCertificates } from '@/modules/certificate';
import type { AuthedContext } from '@/modules/auth';
import { serializePortfolioItem, listPortfolio } from '@/modules/portfolio';
import { listWorkExperiences, serializeWorkExperience } from '@/modules/work-experience';
import { apiError, apiSuccess } from '@/shared/api-response';
import { readResourceVersion } from '@/shared/resource-version';
import { CursorInputError, decodeCursor, encodeCursor, parsePageLimit } from '@/shared/cursor';
import type { ApiResponse } from '@/shared/api-response';
import {
  ImageTooLargeError,
  ImageUploadError,
  UnsupportedImageTypeError,
  createDebugLogger,
} from '@/shared/image-storage';

import type { Static } from 'elysia';

import type {
  avatarUploadSchema,
  publicProfileParamsSchema,
  publicProfileResponseSchema,
  profileResponseSchema,
  profileUpdateSchema,
  reviewsQuerySchema,
  reviewsResponseSchema,
} from './profile.schema';
import {
  getPreviousAvatarFile,
  getProfileReputation,
  getProfileReviews,
  getPublicProfile as getPublicProfileRecord,
  getProfile,
  markAvatarDeleted,
  removeStudentAvatar,
  replaceStudentAvatar,
  updateProfile,
} from './profile.service';
import { avatarStorage } from './profile.storage';

type Profile = Static<typeof profileResponseSchema>['data'];
type PublicProfile = Static<typeof publicProfileResponseSchema>['data'];

type StoredProfileAvatar = NonNullable<Awaited<ReturnType<typeof getProfile>>>['avatar'];

const debugAvatarUpload = createDebugLogger('avatar-upload');

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

const publicProfileNotFound = (set: AuthedContext['set']) => {
  set.status = 404;

  return apiError('PROFILE_NOT_FOUND', 'Profile not found');
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

export const getReputation = async ({
  session,
}: AuthedContext): Promise<ApiResponse<Awaited<ReturnType<typeof getProfileReputation>>>> =>
  apiSuccess(await getProfileReputation(session.user.id));

type Reviews = Static<typeof reviewsResponseSchema>['data'];

type ReviewQuery = Static<typeof reviewsQuerySchema>;

const serializeReviews = (rows: Awaited<ReturnType<typeof getProfileReviews>>['rows']): Reviews['items'] =>
  rows.map((row) => {
    let avatar: { url: string } | null = null;
    if (row.avatarBucket && row.avatarObjectKey) {
      try {
        avatar = { url: avatarStorage.linkFor({ bucket: row.avatarBucket, objectKey: row.avatarObjectKey }) };
      } catch {
        avatar = null;
      }
    }
    return {
      id: row.id,
      reviewer: { displayName: `${row.reviewerFirstName} ${row.reviewerLastName}`.trim(), avatar },
      rating: row.rating,
      comment: row.comment,
      createdAt: row.createdAt.toISOString(),
      quest: { id: row.questId, title: row.questTitle },
    };
  });

export const getReviews = async (context?: AuthedContext & { query: ReviewQuery }): Promise<ApiResponse<Reviews>> => {
  if (!context) return apiSuccess({ items: [], total: 0, nextCursor: null });
  const { query, session, set } = context;
  try {
    const limit = parsePageLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const result = await getProfileReviews(session.user.id, { rating: query.rating, limit, cursor });
    const last = result.rows[result.rows.length - 1];
    return apiSuccess({
      items: serializeReviews(result.rows),
      total: result.total,
      nextCursor: result.hasNext && last ? encodeCursor({ startTime: last.createdAt.toISOString(), id: last.id }) : null,
    });
  } catch (error) {
    if (!(error instanceof CursorInputError)) throw error;
    set.status = 400;
    return apiError(error.code, error.message);
  }
};

export const getPublicReviews = async ({
  params,
  query,
  set,
}: AuthedContext & { params: Static<typeof publicProfileParamsSchema>; query: ReviewQuery }): Promise<ApiResponse<Reviews>> => {
  try {
    if (!(await getPublicProfileRecord(params.userId))) {
      set.status = 404;
      return apiError('PROFILE_NOT_FOUND', 'Profile not found');
    }
    const limit = parsePageLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const result = await getProfileReviews(params.userId, { rating: query.rating, limit, cursor });
    const last = result.rows[result.rows.length - 1];
    return apiSuccess({
      items: serializeReviews(result.rows),
      total: result.total,
      nextCursor: result.hasNext && last ? encodeCursor({ startTime: last.createdAt.toISOString(), id: last.id }) : null,
    });
  } catch (error) {
    if (!(error instanceof CursorInputError)) throw error;
    set.status = 400;
    return apiError(error.code, error.message);
  }
};

export const getPublicProfile = async ({
  params,
  set,
}: AuthedContext & { params: Static<typeof publicProfileParamsSchema> }): Promise<
  ApiResponse<PublicProfile>
> => {
  const profile = await getPublicProfileRecord(params.userId);

  if (!profile) return publicProfileNotFound(set);

  const [portfolio, certificates, experience] = await Promise.all([
    listPortfolio(params.userId),
    listCertificates(params.userId),
    listWorkExperiences(params.userId),
  ]);

  return apiSuccess({
    ...profile,
    avatar: describeAvatar(profile.avatar),
    version: profile.version,
    portfolio: portfolio.map(serializePortfolioItem),
    certificates: certificates.map(serializeCertificate),
    experience: experience.map(serializeWorkExperience),
  });
};

export const updateOwnProfile = async ({
  request,
  session,
  body,
  set,
}: AuthedContext & { body: Static<typeof profileUpdateSchema> }): Promise<ApiResponse<Profile>> => {
  const versionHeader = readResourceVersion(request);
  if (versionHeader.invalid) {
    set.status = 400;
    return apiError('INVALID_VERSION', 'Resource version must be a positive integer');
  }

  const outcome = await updateProfile(session.user.id, body, versionHeader.value);

  if (outcome === 'student-not-found') return userNotFound(set);

  if (outcome === 'department-not-found') {
    set.status = 400;
    return apiError('DEPARTMENT_NOT_FOUND', 'Department not found');
  }

  if (outcome === 'conflict') {
    set.status = 409;
    return apiError('CONFLICT', 'Profile was changed by another request');
  }

  const profile = await getProfile(session.user.id);
  if (!profile) return userNotFound(set);

  const { avatar, ...rest } = profile;
  return apiSuccess({ ...rest, avatar: describeAvatar(avatar) });
};

export const deleteAvatar = async ({
  session,
  set,
}: AuthedContext): Promise<ApiResponse<{ fileId: string | null; version: number; avatar: null }>> => {
  const result = await removeStudentAvatar(session.user.id);
  if (!result) return userNotFound(set);

  if (result.bucket && result.objectKey) {
    try {
      await avatarStorage.delete(result.bucket, result.objectKey);
    } catch (error) {
      console.error('[avatar-delete] Object deletion failed', error);
    }
  }

  return apiSuccess({ fileId: null, version: result.version, avatar: null });
};

export const setAvatar = async ({
  body,
  session,
  set,
}: AuthedContext & { body: Static<typeof avatarUploadSchema> }): Promise<
  ApiResponse<{ fileId: string; version: number; avatar: Profile['avatar'] }>
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
    if (error instanceof ImageTooLargeError) {
      set.status = 413;
      return apiError('AVATAR_TOO_LARGE', error.message);
    }
    if (error instanceof UnsupportedImageTypeError) {
      set.status = 415;
      return apiError('UNSUPPORTED_AVATAR_TYPE', error.message);
    }
    if (error instanceof ImageUploadError) {
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

    const avatar = describeAvatar({ fileId: result.fileId, ...storedAvatar });
    return apiSuccess({
      fileId: result.fileId,
      version: result.version,
      avatar,
    });
  } catch (error) {
    await discardUploadedAvatar(storedAvatar.bucket, storedAvatar.objectKey);
    throw error;
  }
};
