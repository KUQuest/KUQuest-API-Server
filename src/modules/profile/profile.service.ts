import { eq } from 'drizzle-orm';

import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';

import type { StoredAvatar } from './profile.storage';

export const replaceStudentAvatar = async (
  userId: string,
  storedAvatar: StoredAvatar,
): Promise<{ fileId: string } | undefined> =>
  db.transaction(async (transaction) => {
    const [student] = await transaction
      .select({ id: authUser.id })
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

    return createdFile;
  });
