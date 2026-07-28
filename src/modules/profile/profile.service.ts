import { db } from '@/database/client';
import { faculty, major } from '@/database/schema/academic.schema';
import { authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';

import type { Static } from 'elysia';
import { and, eq, isNull } from 'drizzle-orm';

import type { profileUpdateSchema } from './profile.schema';
import type { StoredAvatar } from './profile.storage';

type ProfileUpdate = Static<typeof profileUpdateSchema>;

export type ProfileUpdateOutcome = 'updated' | 'student-not-found' | 'major-not-found';

const foreignKeyViolation = '23503';

// Drizzle wraps the driver's error, so the SQLSTATE that names the cause sits further
// down the chain than the error we are handed.
const isMissingMajor = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;

  if ((error as { code?: unknown }).code === foreignKeyViolation) return true;

  return isMissingMajor((error as { cause?: unknown }).cause);
};

const studentExists = async (userId: string) => {
  const [row] = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.id, userId))
    .limit(1);

  return Boolean(row);
};

/**
 * A write that matched nobody is not a success, and neither is one naming a major that
 * is not there. The foreign key decides the latter: checking first would only tell us
 * what was true a moment ago, and the write would still fail if it changed since.
 */
export const updateProfile = async (
  userId: string,
  data: ProfileUpdate,
): Promise<ProfileUpdateOutcome> => {
  // A request that changes nothing still has to say whether the student is there, and
  // Drizzle rejects an empty update, so ask the row directly.
  if (Object.keys(data).length === 0) {
    return (await studentExists(userId)) ? 'updated' : 'student-not-found';
  }

  try {
    const updated = await db
      .update(authUser)
      .set(data)
      .where(eq(authUser.id, userId))
      .returning({ id: authUser.id });

    return updated.length > 0 ? 'updated' : 'student-not-found';
  } catch (error) {
    if (isMissingMajor(error)) return 'major-not-found';

    throw error;
  }
};

export const getProfile = async (userId: string) => {
  const [row] = await db
    .select({
      email: authUser.email,
      firstName: authUser.firstName,
      lastName: authUser.lastName,
      bio: authUser.bio,
      telephone: authUser.telephone,
      studentId: authUser.studentId,
      academicYear: authUser.academicYear,
      majorId: major.id,
      majorName: major.name,
      facultyName: faculty.name,
      avatarFileId: file.id,
      avatarBucket: file.bucket,
      avatarObjectKey: file.objectKey,
    })
    .from(authUser)
    .leftJoin(major, eq(authUser.majorId, major.id))
    .leftJoin(faculty, eq(major.facultyId, faculty.id))
    // A tombstoned file is a deleted avatar, so it must read as no avatar at all.
    .leftJoin(file, and(eq(authUser.imageFileId, file.id), isNull(file.deletedAt)))
    .where(eq(authUser.id, userId))
    .limit(1);

  if (!row) return undefined;

  const {
    majorId,
    majorName,
    facultyName,
    avatarFileId,
    avatarBucket,
    avatarObjectKey,
    ...profile
  } = row;

  return {
    ...profile,
    // A major always belongs to a faculty, so the joins either all resolve or none do.
    major:
      majorId && majorName && facultyName
        ? { id: majorId, name: majorName, faculty: { name: facultyName } }
        : null,
    avatar:
      avatarFileId && avatarBucket && avatarObjectKey
        ? { fileId: avatarFileId, bucket: avatarBucket, objectKey: avatarObjectKey }
        : null,
  };
};

export const replaceStudentAvatar = async (
  userId: string,
  storedAvatar: StoredAvatar,
): Promise<{ fileId: string; previousFileId: string | null } | undefined> =>
  db.transaction(async (transaction) => {
    const [student] = await transaction
      .select({
        id: authUser.id,
        previousFileId: authUser.imageFileId,
      })
      .from(authUser)
      .where(eq(authUser.id, userId))
      .limit(1)
      .for('update');

    if (!student) return undefined;

    const [createdFile] = await transaction
      .insert(file)
      .values({
        ...storedAvatar,
        uploadedByUserId: userId,
      })
      .returning({ fileId: file.id });

    await transaction
      .update(authUser)
      .set({ imageFileId: createdFile.fileId })
      .where(eq(authUser.id, userId));

    return {
      ...createdFile,
      previousFileId: student.previousFileId,
    };
  });

export const getPreviousAvatarFile = async (
  userId: string,
  fileId: string,
): Promise<{ bucket: string; objectKey: string } | undefined> => {
  const [previousFile] = await db
    .select({
      bucket: file.bucket,
      objectKey: file.objectKey,
    })
    .from(file)
    .where(
      and(
        eq(file.id, fileId),
        eq(file.uploadedByUserId, userId),
        isNull(file.deletedAt),
      ),
    )
    .limit(1);

  return previousFile;
};

export const markAvatarDeleted = async (
  userId: string,
  fileId: string,
): Promise<void> => {
  await db
    .update(file)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(file.id, fileId),
        eq(file.uploadedByUserId, userId),
      ),
    );
};
