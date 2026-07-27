import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';

import { and, eq } from 'drizzle-orm';

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

export const removePreviousAvatarFile = async (
  userId: string,
  fileId: string,
): Promise<{ objectKey: string } | undefined> => {
  const [removedFile] = await db
    .delete(file)
    .where(
      and(
        eq(file.id, fileId),
        eq(file.uploadedByUserId, userId),
      ),
    )
    .returning({ objectKey: file.objectKey });

  return removedFile;
};
