import { db } from '@/database/client';
import { quest } from '@/database/schema/quest.schema';

import { inArray } from 'drizzle-orm';

/**
 * Reads the title of each Quest in one query. Quest Hide removes a Quest from discovery only,
 * so a hidden Quest keeps its title here: a Member can still read their own Wallet history.
 */
export const readQuestTitles = async (questIds: string[]): Promise<Map<string, string>> => {
  const uniqueIds = [...new Set(questIds)];
  if (uniqueIds.length === 0) return new Map();
  const rows = await db
    .select({ id: quest.id, title: quest.title })
    .from(quest)
    .where(inArray(quest.id, uniqueIds));
  return new Map(rows.map((row) => [row.id, row.title]));
};
