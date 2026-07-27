import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';

import { and, eq, isNull } from 'drizzle-orm';

import type { StoredAvatar } from './profile.storage';

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
