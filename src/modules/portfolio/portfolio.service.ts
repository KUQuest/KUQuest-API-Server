import { db } from '@/database/client';
import { file } from '@/database/schema/file.schema';
import {
  profilePortfolioItem,
  profilePortfolioItemImage,
} from '@/database/schema/profile.schema';

import { and, asc, eq, sql } from 'drizzle-orm';

import type { StoredPortfolioImage } from './portfolio.storage';

export type PortfolioImage = {
  fileId: string;
  position: number;
  bucket: string;
  objectKey: string;
};

export type PortfolioItem = {
  id: string;
  version: number;
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
      version: profilePortfolioItem.version,
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
        version: row.version,
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

export type PortfolioUpdateOutcome = 'updated' | 'not-found' | 'conflict';

export const updatePortfolio = async (
  userId: string,
  portfolioId: string,
  data: { title?: string; description?: string },
  expectedVersion?: number,
): Promise<PortfolioUpdateOutcome> => {
  const current = await db
    .select({ version: profilePortfolioItem.version })
    .from(profilePortfolioItem)
    .where(ownedBy(userId, portfolioId))
    .limit(1);

  if (current.length === 0) return 'not-found';
  if (expectedVersion !== undefined && current[0]!.version !== expectedVersion) return 'conflict';
  if (Object.keys(data).length === 0) return 'updated';

  const updated = await db
    .update(profilePortfolioItem)
    .set({ ...data, updatedAt: new Date(), version: sql`${profilePortfolioItem.version} + 1` })
    .where(
      expectedVersion === undefined
        ? ownedBy(userId, portfolioId)
        : and(ownedBy(userId, portfolioId), eq(profilePortfolioItem.version, expectedVersion)),
    )
    .returning({ id: profilePortfolioItem.id });

  return updated.length > 0 ? 'updated' : 'conflict';
};

export type PortfolioDeleteOutcome =
  | { outcome: 'deleted'; images: Array<{ fileId: string; bucket: string; objectKey: string }>; version: number }
  | { outcome: 'not-found' }
  | { outcome: 'conflict' };

export const deletePortfolio = async (
  userId: string,
  portfolioId: string,
  expectedVersion?: number,
): Promise<PortfolioDeleteOutcome> =>
  db.transaction(async (transaction) => {
    const [current] = await transaction
      .select({ version: profilePortfolioItem.version })
      .from(profilePortfolioItem)
      .where(ownedBy(userId, portfolioId))
      .limit(1)
      .for('update');

    if (!current) return { outcome: 'not-found' };
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      return { outcome: 'conflict' };
    }

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

    if (deleted.length === 0) return { outcome: 'conflict' };

    return { outcome: 'deleted', images, version: current.version + 1 };
  });

export const replacePortfolioImage = async (
  userId: string,
  portfolioId: string,
  fileData: StoredPortfolioImage,
  targetFileId: string,
  expectedVersion?: number,
): Promise<
  | {
      fileId: string;
      previousFileId: string;
      previousBucket: string;
      previousObjectKey: string;
      version: number;
    }
  | { outcome: 'not-found' }
  | { outcome: 'conflict' }
> =>
  db.transaction(async (transaction) => {
    const [item] = await transaction
      .select({ version: profilePortfolioItem.version })
      .from(profilePortfolioItem)
      .where(ownedBy(userId, portfolioId))
      .limit(1)
      .for('update');

    if (!item) return { outcome: 'not-found' };
    if (expectedVersion !== undefined && item.version !== expectedVersion) {
      return { outcome: 'conflict' };
    }

    const [oldImage] = await transaction
      .select({ fileId: file.id, bucket: file.bucket, objectKey: file.objectKey })
      .from(profilePortfolioItemImage)
      .innerJoin(file, eq(profilePortfolioItemImage.fileId, file.id))
      .where(
        and(
          eq(profilePortfolioItemImage.portfolioItemId, portfolioId),
          eq(profilePortfolioItemImage.fileId, targetFileId),
        ),
      )
      .limit(1);

    if (!oldImage) return { outcome: 'not-found' };

    const [createdFile] = await transaction
      .insert(file)
      .values({ ...fileData, uploadedByUserId: userId })
      .returning({ fileId: file.id });

    await transaction
      .update(profilePortfolioItemImage)
      .set({ fileId: createdFile.fileId })
      .where(
        and(
          eq(profilePortfolioItemImage.portfolioItemId, portfolioId),
          eq(profilePortfolioItemImage.fileId, oldImage.fileId),
        ),
      );
    await transaction
      .update(profilePortfolioItem)
      .set({ version: sql`${profilePortfolioItem.version} + 1`, updatedAt: new Date() })
      .where(eq(profilePortfolioItem.id, portfolioId));

    return {
      fileId: createdFile.fileId,
      previousFileId: oldImage.fileId,
      previousBucket: oldImage.bucket,
      previousObjectKey: oldImage.objectKey,
      version: item.version + 1,
    };
  });

export const deletePortfolioImage = async (
  userId: string,
  portfolioId: string,
  fileId: string,
  expectedVersion?: number,
): Promise<{ outcome: 'deleted'; bucket: string; objectKey: string; version: number } | { outcome: 'not-found' } | { outcome: 'conflict' }> =>
  db.transaction(async (transaction) => {
    const [item] = await transaction
      .select({ version: profilePortfolioItem.version })
      .from(profilePortfolioItem)
      .where(ownedBy(userId, portfolioId))
      .limit(1)
      .for('update');
    if (!item) return { outcome: 'not-found' };
    if (expectedVersion !== undefined && item.version !== expectedVersion) return { outcome: 'conflict' };

    const [image] = await transaction
      .select({ bucket: file.bucket, objectKey: file.objectKey })
      .from(profilePortfolioItemImage)
      .innerJoin(file, eq(profilePortfolioItemImage.fileId, file.id))
      .where(
        and(
          eq(profilePortfolioItemImage.portfolioItemId, portfolioId),
          eq(profilePortfolioItemImage.fileId, fileId),
        ),
      )
      .limit(1);
    if (!image) return { outcome: 'not-found' };

    await transaction
      .delete(profilePortfolioItemImage)
      .where(
        and(
          eq(profilePortfolioItemImage.portfolioItemId, portfolioId),
          eq(profilePortfolioItemImage.fileId, fileId),
        ),
      );
    await transaction
      .update(file)
      .set({ deletedAt: new Date() })
      .where(eq(file.id, fileId));
    await transaction
      .update(profilePortfolioItem)
      .set({ version: sql`${profilePortfolioItem.version} + 1`, updatedAt: new Date() })
      .where(eq(profilePortfolioItem.id, portfolioId));

    return { outcome: 'deleted', ...image, version: item.version + 1 };
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
