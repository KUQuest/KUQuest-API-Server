import { db } from '@/database/client';
import { file } from '@/database/schema/file.schema';
import {
  profilePortfolioItem,
  profilePortfolioItemImage,
} from '@/database/schema/profile.schema';

import { and, asc, eq } from 'drizzle-orm';

import type { StoredPortfolioImage } from './portfolio.storage';

export type PortfolioImage = {
  fileId: string;
  position: number;
  bucket: string;
  objectKey: string;
};

export type PortfolioItem = {
  id: string;
  title: string;
  description: string | null;
  createdAt: Date;
  images: PortfolioImage[];
};

const ownedBy = (userId: string, portfolioId: string) =>
  and(eq(profilePortfolioItem.id, portfolioId), eq(profilePortfolioItem.userId, userId));

export const listPortfolio = async (userId: string): Promise<PortfolioItem[]> => {
  const rows = await db
    .select({
      id: profilePortfolioItem.id,
      title: profilePortfolioItem.title,
      description: profilePortfolioItem.description,
      createdAt: profilePortfolioItem.createdAt,
      imageFileId: file.id,
      imagePosition: profilePortfolioItemImage.position,
      imageBucket: file.bucket,
      imageObjectKey: file.objectKey,
    })
    .from(profilePortfolioItem)
    .leftJoin(
      profilePortfolioItemImage,
      eq(profilePortfolioItemImage.portfolioItemId, profilePortfolioItem.id),
    )
    .leftJoin(file, eq(profilePortfolioItemImage.fileId, file.id))
    .where(eq(profilePortfolioItem.userId, userId))
    .orderBy(asc(profilePortfolioItem.createdAt), asc(profilePortfolioItemImage.position));

  const items = new Map<string, PortfolioItem>();

  for (const row of rows) {
    let item = items.get(row.id);
    if (!item) {
      item = {
        id: row.id,
        title: row.title,
        description: row.description,
        createdAt: row.createdAt,
        images: [],
      };
      items.set(row.id, item);
    }

    if (row.imageFileId && row.imageBucket && row.imageObjectKey && row.imagePosition !== null) {
      item.images.push({
        fileId: row.imageFileId,
        position: row.imagePosition,
        bucket: row.imageBucket,
        objectKey: row.imageObjectKey,
      });
    }
  }

  return [...items.values()];
};

export const createPortfolio = async (
  userId: string,
  data: { title: string; description?: string; images: StoredPortfolioImage[] },
): Promise<{ id: string }> =>
  db.transaction(async (transaction) => {
    const [item] = await transaction
      .insert(profilePortfolioItem)
      .values({ userId, title: data.title, description: data.description ?? null })
      .returning({ id: profilePortfolioItem.id });

    await Promise.all(
      data.images.map(async (image, position) => {
        const [createdFile] = await transaction
          .insert(file)
          .values({ ...image, uploadedByUserId: userId })
          .returning({ id: file.id });

        await transaction.insert(profilePortfolioItemImage).values({
          portfolioItemId: item.id,
          fileId: createdFile.id,
          position,
        });
      }),
    );

    return { id: item.id };
  });

export type PortfolioUpdateOutcome = 'updated' | 'not-found';

export const updatePortfolio = async (
  userId: string,
  portfolioId: string,
  data: { title?: string; description?: string },
): Promise<PortfolioUpdateOutcome> => {
  if (Object.keys(data).length === 0) {
    const [row] = await db
      .select({ id: profilePortfolioItem.id })
      .from(profilePortfolioItem)
      .where(ownedBy(userId, portfolioId))
      .limit(1);

    return row ? 'updated' : 'not-found';
  }

  const updated = await db
    .update(profilePortfolioItem)
    .set({ ...data, updatedAt: new Date() })
    .where(ownedBy(userId, portfolioId))
    .returning({ id: profilePortfolioItem.id });

  return updated.length > 0 ? 'updated' : 'not-found';
};

export type PortfolioDeleteOutcome =
  | { outcome: 'deleted'; images: Array<{ fileId: string; bucket: string; objectKey: string }> }
  | { outcome: 'not-found' };

export const deletePortfolio = async (
  userId: string,
  portfolioId: string,
): Promise<PortfolioDeleteOutcome> =>
  db.transaction(async (transaction) => {
    const images = await transaction
      .select({ fileId: file.id, bucket: file.bucket, objectKey: file.objectKey })
      .from(profilePortfolioItem)
      .innerJoin(
        profilePortfolioItemImage,
        eq(profilePortfolioItemImage.portfolioItemId, profilePortfolioItem.id),
      )
      .innerJoin(file, eq(profilePortfolioItemImage.fileId, file.id))
      .where(ownedBy(userId, portfolioId))
      .for('update');

    const deleted = await transaction
      .delete(profilePortfolioItem)
      .where(ownedBy(userId, portfolioId))
      .returning({ id: profilePortfolioItem.id });

    if (deleted.length === 0) return { outcome: 'not-found' };

    return { outcome: 'deleted', images };
  });

export const markPortfolioImageDeleted = async (
  userId: string,
  fileId: string,
): Promise<void> => {
  await db
    .update(file)
    .set({ deletedAt: new Date() })
    .where(and(eq(file.id, fileId), eq(file.uploadedByUserId, userId)));
};
