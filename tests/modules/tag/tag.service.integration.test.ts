import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { db, sql } from '@/database/client';
import { tag } from '@/database/schema/tag.schema';
import { listTags } from '@/modules/tag/tag.service';

import { randomUUID } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';

const prefix = `TestTag_${randomUUID().slice(0, 8)}`;
const fixtureNames = [`${prefix}_Zebra`, `${prefix}_Alpha`, `${prefix}_Beta`, `${prefix}_Gamma`];
let tagIds: string[] = [];

beforeAll(async () => {
  try {
    await sql`select 1`;
  } catch (cause) {
    throw new Error(
      'These tests need PostgreSQL. Start it with `docker compose up -d postgres`, then apply the schema with `bun run db:migrate`.',
      { cause }
    );
  }
});

afterEach(async () => {
  if (tagIds.length > 0) {
    await db.delete(tag).where(inArray(tag.id, tagIds));
    tagIds = [];
  }
});

describe('Tag persistence and search service', () => {
  it('lists fixture Tags in ascending name order with pagination metadata', async () => {
    const created = await db
      .insert(tag)
      .values(fixtureNames.map((name) => ({ name })))
      .returning({ id: tag.id, name: tag.name });
    tagIds = created.map(({ id }) => id);

    const result = await listTags({ q: prefix });

    expect(result.items.map(({ name }) => name)).toEqual([
      `${prefix}_Alpha`,
      `${prefix}_Beta`,
      `${prefix}_Gamma`,
      `${prefix}_Zebra`,
    ]);
    expect(result.nextCursor).toBeNull();
  });

  it('filters tags by case-insensitive keyword search', async () => {
    const created = await db
      .insert(tag)
      .values(fixtureNames.map((name) => ({ name })))
      .returning({ id: tag.id, name: tag.name });
    tagIds = created.map(({ id }) => id);

    const result = await listTags({ q: 'alpha' });
    const matched = result.items.filter(({ id }) => tagIds.includes(id));

    expect(matched.length).toBe(1);
    expect(matched[0]?.name).toBe(`${prefix}_Alpha`);
  });

  it('returns Thai labels for fixed Tags without changing their canonical names or IDs', async () => {
    const created = await db
      .insert(tag)
      .values({ name: 'Cleaning' })
      .onConflictDoNothing({ target: tag.name })
      .returning({ id: tag.id });
    tagIds = created.map(({ id }) => id);
    const [existing] = await db.select({ id: tag.id }).from(tag).where(eq(tag.name, 'Cleaning'));

    const result = await listTags({ q: 'Cleaning' });
    expect(result.items.find((item) => item.id === existing?.id)).toEqual({
      id: existing?.id,
      name: 'Cleaning',
      nameTh: 'ทำความสะอาด',
    });
  });

  it('walks pages using keyset cursor pagination at limit=1', async () => {
    const created = await db
      .insert(tag)
      .values([`${prefix}_1`, `${prefix}_2`, `${prefix}_3`].map((name) => ({ name })))
      .returning({ id: tag.id, name: tag.name });
    tagIds = created.map(({ id }) => id);

    const page1 = await listTags({ q: prefix, limit: 1 });
    expect(page1.items.length).toBe(1);
    expect(page1.items[0]?.name).toBe(`${prefix}_1`);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listTags({ q: prefix, limit: 1, cursor: page1.nextCursor! });
    expect(page2.items.length).toBe(1);
    expect(page2.items[0]?.name).toBe(`${prefix}_2`);
    expect(page2.nextCursor).not.toBeNull();

    const page3 = await listTags({ q: prefix, limit: 1, cursor: page2.nextCursor! });
    expect(page3.items.length).toBe(1);
    expect(page3.items[0]?.name).toBe(`${prefix}_3`);
    expect(page3.nextCursor).toBeNull();
  });
});
