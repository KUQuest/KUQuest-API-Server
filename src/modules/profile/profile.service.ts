import { db } from '@/database/client';
import { department, faculty, occupation } from '@/database/schema/academic.schema';
import { authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';
import { quest, questAssignment } from '@/database/schema/quest.schema';
import { countReviews, getReceivedRatings, listReviews } from '@/modules/quest/quest-review.service';
import { tag } from '@/database/schema/tag.schema';

import type { Static } from 'elysia';
import { and, asc, count, desc, eq, isNull, sql } from 'drizzle-orm';

import type { profileUpdateSchema } from './profile.schema';
import type { StoredAvatar } from './profile.storage';

type ProfileUpdate = Static<typeof profileUpdateSchema>;

export type ProfileUpdateOutcome =
  | 'updated'
  | 'student-not-found'
  | 'department-not-found'
  | 'conflict';

const foreignKeyViolation = '23503';
const occupationNames = ['Staff', 'Lecturer', 'Student'] as const;
type OccupationName = (typeof occupationNames)[number];

const isOccupationName = (name: string): name is OccupationName =>
  occupationNames.includes(name as OccupationName);

const isMissingDepartment = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;

  if ((error as { code?: unknown }).code === foreignKeyViolation) return true;

  return isMissingDepartment((error as { cause?: unknown }).cause);
};

const studentExists = async (userId: string) => {
  const [row] = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.id, userId))
    .limit(1);

  return Boolean(row);
};

export const getProfileTags = async (userId: string) =>
  db
    .select({ id: tag.id, name: tag.name })
    .from(questAssignment)
    .innerJoin(quest, eq(questAssignment.questId, quest.id))
    .innerJoin(tag, eq(quest.tagId, tag.id))
    .where(
      and(
        eq(questAssignment.workerId, userId),
        eq(questAssignment.assignmentStatus, 'ASSIGNMENT_COMPLETED'),
        eq(quest.questStatus, 'QUEST_COMPLETED'),
      ),
    )
    .groupBy(tag.id, tag.name)
    .orderBy(desc(count(questAssignment.id)), asc(tag.id))
    .limit(3);

export const getProfileReputation = async (userId: string) => {
  const [completed] = await db
    .select({ totalQuests: count(questAssignment.id) })
    .from(questAssignment)
    .innerJoin(quest, eq(questAssignment.questId, quest.id))
    .where(
      and(
        eq(questAssignment.workerId, userId),
        eq(questAssignment.assignmentStatus, 'ASSIGNMENT_COMPLETED'),
        eq(quest.questStatus, 'QUEST_COMPLETED'),
      ),
    );

  const ratings = await getReceivedRatings(userId);
  const distribution = { '5': 0, '4': 0, '3': 0, '2': 0, '1': 0 };
  for (const rating of ratings) distribution[String(rating) as keyof typeof distribution] += 1;

  const validCount = ratings.length;
  const average = validCount === 0 ? null : ratings.reduce((sum, rating) => sum + rating, 0) / validCount;
  return {
    totalQuests: Number(completed?.totalQuests ?? 0),
    rating: { average, count: validCount, distribution },
  };
};

export const getProfileReviews = async (
  userId: string,
  options: { rating?: number; limit?: number; cursor?: { startTime: string; id: string } } = {},
) => {
  const result = await listReviews(userId, options);
  return { ...result, total: await countReviews(userId, options.rating) };
};

export const updateProfile = async (
  userId: string,
  data: ProfileUpdate,
  expectedVersion?: number,
): Promise<ProfileUpdateOutcome> => {
  if (Object.keys(data).length === 0) {
    if (!(await studentExists(userId))) return 'student-not-found';

    if (expectedVersion !== undefined) {
      const [student] = await db
        .select({ version: authUser.version })
        .from(authUser)
        .where(and(eq(authUser.id, userId), eq(authUser.version, expectedVersion)))
        .limit(1);

      if (!student) return 'conflict';
    }

    return 'updated';
  }

  try {
    const updated = await db
      .update(authUser)
      .set({ ...data, version: sql`${authUser.version} + 1` })
      .where(
        expectedVersion === undefined
          ? eq(authUser.id, userId)
          : and(eq(authUser.id, userId), eq(authUser.version, expectedVersion)),
      )
      .returning({ id: authUser.id });

    if (updated.length > 0) return 'updated';
    if (expectedVersion !== undefined && (await studentExists(userId))) return 'conflict';

    return 'student-not-found';
  } catch (error) {
    if (isMissingDepartment(error)) return 'department-not-found';

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
      version: authUser.version,
      occupationId: occupation.id,
      occupationName: occupation.name,
      departmentId: department.id,
      departmentName: department.name,
      facultyName: faculty.name,
      avatarFileId: file.id,
      avatarBucket: file.bucket,
      avatarObjectKey: file.objectKey,
    })
    .from(authUser)
    .leftJoin(department, eq(authUser.departmentId, department.id))
    .leftJoin(faculty, eq(department.facultyId, faculty.id))
    .leftJoin(occupation, eq(authUser.occupationId, occupation.id))
    .leftJoin(file, and(eq(authUser.imageFileId, file.id), isNull(file.deletedAt)))
    .where(eq(authUser.id, userId))
    .limit(1);

  if (!row) return undefined;

  const {
    departmentId,
    departmentName,
    facultyName,
    occupationId,
    occupationName,
    avatarFileId,
    avatarBucket,
    avatarObjectKey,
    ...profile
  } = row;

  return {
    ...profile,
    tags: await getProfileTags(userId),
    department:
      departmentId && departmentName && facultyName
        ? { id: departmentId, name: departmentName, faculty: { name: facultyName } }
        : null,
    occupation:
      occupationId && occupationName && isOccupationName(occupationName)
        ? { id: occupationId, name: occupationName }
        : null,
    avatar:
      avatarFileId && avatarBucket && avatarObjectKey
        ? { fileId: avatarFileId, bucket: avatarBucket, objectKey: avatarObjectKey }
        : null,
  };
};

export const getPublicProfile = async (userId: string) => {
  const [row] = await db
    .select({
      firstName: authUser.firstName,
      lastName: authUser.lastName,
      bio: authUser.bio,
      academicYear: authUser.academicYear,
      version: authUser.version,
      occupationId: occupation.id,
      occupationName: occupation.name,
      departmentId: department.id,
      departmentName: department.name,
      facultyName: faculty.name,
      avatarFileId: file.id,
      avatarBucket: file.bucket,
      avatarObjectKey: file.objectKey,
    })
    .from(authUser)
    .leftJoin(department, eq(authUser.departmentId, department.id))
    .leftJoin(faculty, eq(department.facultyId, faculty.id))
    .leftJoin(occupation, eq(authUser.occupationId, occupation.id))
    .leftJoin(file, and(eq(authUser.imageFileId, file.id), isNull(file.deletedAt)))
    .where(eq(authUser.id, userId))
    .limit(1);

  if (!row) return undefined;

  const {
    departmentId,
    departmentName,
    facultyName,
    occupationId,
    occupationName,
    avatarFileId,
    avatarBucket,
    avatarObjectKey,
    ...profile
  } = row;

  return {
    ...profile,
    department:
      departmentId && departmentName && facultyName
        ? { id: departmentId, name: departmentName, faculty: { name: facultyName } }
        : null,
    occupation:
      occupationId && occupationName && isOccupationName(occupationName)
        ? { id: occupationId, name: occupationName }
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
): Promise<{ fileId: string; previousFileId: string | null; version: number } | undefined> =>
  db.transaction(async (transaction) => {
    const [student] = await transaction
      .select({
        id: authUser.id,
        previousFileId: authUser.imageFileId,
        version: authUser.version,
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
      .set({ imageFileId: createdFile.fileId, version: sql`${authUser.version} + 1` })
      .where(eq(authUser.id, userId));

    return {
      ...createdFile,
      previousFileId: student.previousFileId,
      version: (student.version ?? 1) + 1,
    };
  });

export const removeStudentAvatar = async (
  userId: string,
): Promise<{ bucket: string | null; objectKey: string | null; version: number } | undefined> =>
  db.transaction(async (transaction) => {
    const [student] = await transaction
      .select({
        fileId: authUser.imageFileId,
        version: authUser.version,
        bucket: file.bucket,
        objectKey: file.objectKey,
      })
      .from(authUser)
      .leftJoin(file, and(eq(authUser.imageFileId, file.id), isNull(file.deletedAt)))
      .where(eq(authUser.id, userId))
      .limit(1)
      .for('update', { of: authUser });

    if (!student) return undefined;

    await transaction
      .update(authUser)
      .set({ imageFileId: null, version: sql`${authUser.version} + 1` })
      .where(eq(authUser.id, userId));

    if (student.fileId) {
      await transaction.update(file).set({ deletedAt: new Date() }).where(eq(file.id, student.fileId));
    }

    return student.bucket && student.objectKey
      ? { bucket: student.bucket, objectKey: student.objectKey, version: (student.version ?? 1) + 1 }
      : { bucket: null, objectKey: null, version: (student.version ?? 1) + 1 };
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
