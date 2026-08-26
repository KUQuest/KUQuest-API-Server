import { db, sql } from '@/database/client';
import { tag } from '@/database/schema/tag.schema';
import { fixedTagNames } from '@/shared/tag';

import { asc, inArray } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'bun:test';

const expectedTagNames = [...fixedTagNames];

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

describe('Tag seed', () => {
  it('contains the fixed vocabulary exactly once', async () => {
    const rows = await db
      .select({ name: tag.name })
      .from(tag)
      .where(inArray(tag.name, expectedTagNames))
      .orderBy(asc(tag.name));

    expect(rows.map(({ name }) => name)).toEqual(expectedTagNames);
    expect(new Set(rows.map(({ name }) => name)).size).toBe(expectedTagNames.length);
  });
});
