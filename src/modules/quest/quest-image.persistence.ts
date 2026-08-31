import { db } from '@/database/client';
import { file } from '@/database/schema/file.schema';
import { questImage } from '@/database/schema/quest.schema';

import { asc, eq, sql } from 'drizzle-orm';

type QuestImageTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type SoftDeleteQuestImageInput = {
  questId: string;
  questImageId: string;
  fileId: string;
  deletedAt: Date;
  positionOffset: number;
};

export const softDeleteQuestImageAndRepack = async (
  transaction: QuestImageTransaction,
  input: SoftDeleteQuestImageInput,
): Promise<void> => {
  await transaction.delete(questImage).where(eq(questImage.id, input.questImageId));
  await transaction
    .update(file)
    .set({ deletedAt: input.deletedAt, objectDeletedAt: null })
    .where(eq(file.id, input.fileId));

  await transaction
    .update(questImage)
    .set({ position: sql`${questImage.position} + ${input.positionOffset}` })
    .where(eq(questImage.questId, input.questId));

  const remainingImages = await transaction
    .select({ id: questImage.id })
    .from(questImage)
    .where(eq(questImage.questId, input.questId))
    .orderBy(asc(questImage.position), asc(questImage.id));

  for (const [position, remainingImage] of remainingImages.entries()) {
    await transaction
      .update(questImage)
      .set({ position })
      .where(eq(questImage.id, remainingImage.id));
  }
};
