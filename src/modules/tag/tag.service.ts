import { db } from '@/database/client';
import { tag } from '@/database/schema/tag.schema';

import { asc } from 'drizzle-orm';

export type Tag = {
  id: string;
  name: string;
};

export const listTags = async (): Promise<Tag[]> =>
  db
    .select({ id: tag.id, name: tag.name })
    .from(tag)
    .orderBy(asc(tag.name));
