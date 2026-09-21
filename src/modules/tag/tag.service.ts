import { db } from '@/database/client';
import { quest } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { DEFAULT_PAGE_LIMIT } from '@/shared/cursor';
import { fixedTagNames, type FixedTagName } from '@/shared/tag';

import { and, asc, eq, gt, ilike, inArray, or } from 'drizzle-orm';

import { decodeTagCursor, encodeTagCursor } from './tag.cursor';

export type Tag = {
  id: string;
  name: string;
};

export type TagSearchOptions = {
  q?: string;
  limit?: number;
  cursor?: string;
};

export type TagPage = {
  items: Tag[];
  nextCursor: string | null;
};

export const legacyTagMappings: Partial<Record<string, FixedTagName>> = {
  Content: 'Content Writing & Copywriting',
  Design: 'Graphic Design',
  Frontend: 'Frontend Development',
};

export const listTags = async (options?: TagSearchOptions): Promise<TagPage> => {
  const limit = options?.limit ?? DEFAULT_PAGE_LIMIT;
  const cursorPayload = decodeTagCursor(options?.cursor);

  const rawQuery = options?.q?.trim();
  const searchFilter = rawQuery
    ? ilike(tag.name, `%${rawQuery.replace(/[%_\\]/g, '\\$&')}%`)
    : undefined;

  let probe: Tag[];

  if (cursorPayload) {
    const cursorFilter = or(
      gt(tag.name, cursorPayload.name),
      and(eq(tag.name, cursorPayload.name), gt(tag.id, cursorPayload.id))
    );

    probe = await db
      .select({ id: tag.id, name: tag.name })
      .from(tag)
      .where(and(searchFilter, cursorFilter))
      .orderBy(asc(tag.name), asc(tag.id))
      .limit(limit + 1);
  } else {
    probe = await db
      .select({ id: tag.id, name: tag.name })
      .from(tag)
      .where(searchFilter)
      .orderBy(asc(tag.name), asc(tag.id))
      .limit(limit + 1);
  }

  const hasNext = probe.length > limit;
  const items = hasNext ? probe.slice(0, limit) : probe;
  const lastItem = items[items.length - 1];

  return {
    items,
    nextCursor: hasNext && lastItem ? encodeTagCursor(lastItem) : null,
  };
};

export const seedQuestTags = async (): Promise<{ total: number; removed: number }> =>
  db.transaction(async (tx) => {
    await tx
      .insert(tag)
      .values(fixedTagNames.map((name) => ({ name })))
      .onConflictDoNothing({ target: tag.name });

    const currentTags = await tx.select({ id: tag.id, name: tag.name }).from(tag);
    const tagByName = new Map(currentTags.map((row) => [row.name, row.id]));
    const allowedSet = new Set<string>(fixedTagNames);

    const legacyTags = currentTags.filter((row) => !allowedSet.has(row.name));
    const legacyIds = legacyTags.map((row) => row.id);

    if (legacyIds.length > 0) {
      await Promise.all(
        legacyTags.map(async (legacy) => {
          const targetName = legacyTagMappings[legacy.name] ?? 'General Assistance';
          const targetId = tagByName.get(targetName)!;
          await tx.update(quest).set({ tagId: targetId }).where(eq(quest.tagId, legacy.id));
        })
      );

      await tx.delete(tag).where(inArray(tag.id, legacyIds));
    }

    return {
      total: fixedTagNames.length,
      removed: legacyTags.length,
    };
  });
