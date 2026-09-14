import { db, sql } from '@/database/client';
import { file } from '@/database/schema/file.schema';
import { CursorInputError, decodeCursor, encodeCursor } from '@/shared/cursor';
import { readKeysetPage, type KeysetSort } from '@/shared/keyset-page';

import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'bun:test';

/**
 * The reader pages rows that PostgreSQL wrote at microsecond precision through a cursor that
 * carries milliseconds. Three of the four rows below sit inside the same millisecond, and two
 * share one microsecond, so a boundary built from the cursor millisecond alone repeats a row or
 * reports the page complete. Identifiers are explicit, because the tiebreaker orders on them.
 */
const bucket = `keyset-page-${crypto.randomUUID()}`;
const first = 'aaaaaaaa-0000-4000-8000-000000000001';
const tieLow = 'aaaaaaaa-0000-4000-8000-000000000002';
const tieHigh = 'aaaaaaaa-0000-4000-8000-000000000003';
const last = 'aaaaaaaa-0000-4000-8000-000000000004';
const deleted = 'aaaaaaaa-0000-4000-8000-00000000ffff';

const seedFile = async (id: string, createdAt: string): Promise<void> => {
  await sql`
    insert into file (id, bucket, object_key, content_type, size_bytes, created_at)
    values (${id}, ${bucket}, ${id}, ${'text/plain'}, ${1}, ${createdAt}::timestamptz)
  `;
};

await seedFile(first, '2030-08-05T00:00:00.100200Z');
await seedFile(tieLow, '2030-08-05T00:00:00.100800Z');
await seedFile(tieHigh, '2030-08-05T00:00:00.100800Z');
await seedFile(last, '2030-08-05T00:00:00.102400Z');

const readPage = (cursor?: string, page: { limit?: number; sort?: KeysetSort } = {}) =>
  readKeysetPage({
    anchor: { time: file.createdAt, id: file.id },
    cursor: decodeCursor(cursor),
    limit: page.limit ?? 1,
    sort: page.sort,
    where: eq(file.bucket, bucket),
    read: ({ where, orderBy, limit }) =>
      db
        .select({ id: file.id, createdAt: file.createdAt })
        .from(file)
        .where(where)
        .orderBy(...orderBy)
        .limit(limit),
    rowCursor: (row) => ({ startTime: row.createdAt, id: row.id }),
    invalidCursor: () => new CursorInputError('INVALID_CURSOR', 'cursor does not match a File'),
  });

/** Follows nextCursor one row at a time and collects the identifiers in page order. */
const walk = async (sort?: KeysetSort): Promise<string[]> => {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 8; page += 1) {
    const result = await readPage(cursor, { limit: 1, sort });
    ids.push(...result.rows.map((row) => row.id));
    if (!result.nextCursor) return ids;
    cursor = encodeCursor(result.nextCursor);
  }
  throw new Error('The reader never reported the last page.');
};

afterAll(async () => {
  await db.delete(file).where(eq(file.bucket, bucket));
});

describe('readKeysetPage', () => {
  it('walks newest-first through one millisecond and one microsecond tie', async () => {
    expect(await walk()).toEqual([last, tieHigh, tieLow, first]);
  });

  it('walks oldest-first through the same rows in reverse', async () => {
    expect(await walk('oldest')).toEqual([first, tieLow, tieHigh, last]);
  });

  it('reports no next page when the last page ends on the last row', async () => {
    const exact = await readPage(undefined, { limit: 4 });
    expect(exact.hasNext).toBe(false);
    expect(exact.nextCursor).toBeNull();

    const short = await readPage(undefined, { limit: 3 });
    expect(short.hasNext).toBe(true);
    expect(short.nextCursor).toEqual({ startTime: '2030-08-05T00:00:00.100Z', id: tieLow });
  });

  it('rejects a cursor whose anchor row is gone', async () => {
    await seedFile(deleted, '2030-08-05T00:00:00.103000Z');
    const gone = await readPage(undefined, { limit: 1 });
    expect(gone.rows.map((row) => row.id)).toEqual([deleted]);
    const cursor = encodeCursor(gone.nextCursor!);
    await db.delete(file).where(eq(file.id, deleted));

    expect(readPage(cursor)).rejects.toThrow('cursor does not match a File');
  });

  it('rejects a cursor whose millisecond no longer matches its anchor row', async () => {
    const cursor = encodeCursor({ startTime: '2030-08-05T00:00:00.999Z', id: first });

    expect(readPage(cursor)).rejects.toThrow('cursor does not match a File');
  });
});
