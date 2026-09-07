import { db, sql } from '@/database/client';
import { tag } from '@/database/schema/tag.schema';
import { listTags } from '@/modules/tag/tag.service';

import { randomUUID } from 'node:crypto';

import { inArray } from 'drizzle-orm';
import { beforeAll, afterEach, describe, expect, it } from 'bun:test';

const tagNames = [`Tag Z ${randomUUID()}`, `Tag A ${randomUUID()}`];
let tagIds: string[] = [];

beforeAll(async () => {
  try {
    await sql`select 1`;
  } catch (cause) {
    throw new Error(
      'These tests need PostgreSQL. Start it with `docker compose up -d postgres`, then apply the schema with `bun run db:migrate`.',
      { cause },
    );
  }
});

afterEach(async () => {
  if (tagIds.length > 0) {
    await db.delete(tag).where(inArray(tag.id, tagIds));
    tagIds = [];
  }
});

describe('Tag persistence', () => {
  it('lists fixture Tags in ascending name order', async () => {
    const created = await db
      .insert(tag)
      .values(tagNames.map((name) => ({ name })))
      .returning({ id: tag.id, name: tag.name });
    tagIds = created.map(({ id }) => id);

    const rows = await listTags();

    expect(rows.filter(({ id }) => tagIds.includes(id))).toEqual(
      [...created].sort((left, right) => left.name.localeCompare(right.name)),
    );
  });
});
