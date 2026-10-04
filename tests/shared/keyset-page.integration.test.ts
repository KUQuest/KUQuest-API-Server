import { db, sql } from '@/database/client';
import { file } from '@/database/schema/file.schema';
import { CursorInputError, decodeCursor, encodeCursor } from '@/shared/cursor';
import { readKeysetPage, type KeysetSort } from '@/shared/keyset-page';

import { and, eq, ne, type SQL } from 'drizzle-orm';
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

const readPage = (
  cursor?: string,
  page: { limit?: number; sort?: KeysetSort; where?: SQL | undefined } = {}
) =>
  readKeysetPage({
    anchor: { time: file.createdAt, id: file.id },
    cursor: decodeCursor(cursor),
    limit: page.limit ?? 1,
    sort: page.sort,
    where: page.where ?? eq(file.bucket, bucket),
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
const walk = async (sort?: KeysetSort, where?: SQL): Promise<string[]> => {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 8; page += 1) {
    // Each page cursor comes from the previous page, so these reads must remain sequential.
    // eslint-disable-next-line no-await-in-loop
    const result = await readPage(cursor, { limit: 1, sort, where });
    ids.push(...result.rows.map((row) => row.id));
    if (!result.nextCursor) return ids;
    cursor = encodeCursor(result.nextCursor);
  }
  throw new Error('The reader never reported the last page.');
};

/**
 * Settles a read that must fail and returns its error. Under Bun 1.3.14 on Windows,
 * `expect(readKeysetPage(...)).rejects` never settles: the anchor-check query stalls in
 * PostgreSQL `ClientRead` until the test times out. Settling the promise first does not stall.
 */
const rejectionOf = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (error: unknown) => error
  );

const expectFileCursorRejected = async (work: Promise<unknown>): Promise<void> => {
  const error = await rejectionOf(work);
  expect(error).toBeInstanceOf(CursorInputError);
  expect((error as Error).message).toBe('cursor does not match a File');
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

    await expectFileCursorRejected(readPage(cursor));
  });

  it('rejects a cursor whose millisecond no longer matches its anchor row', async () => {
    const cursor = encodeCursor({ startTime: '2030-08-05T00:00:00.999Z', id: first });

    await expectFileCursorRejected(readPage(cursor));
  });

  it('reports no next page when the oldest-first page ends on the last row', async () => {
    const exact = await readPage(undefined, { limit: 4, sort: 'oldest' });
    expect(exact.hasNext).toBe(false);
    expect(exact.nextCursor).toBeNull();

    const short = await readPage(undefined, { limit: 3, sort: 'oldest' });
    expect(short.hasNext).toBe(true);
    expect(short.nextCursor).toEqual({ startTime: '2030-08-05T00:00:00.100Z', id: tieHigh });
  });

  it('applies the list filters together with the page boundary', async () => {
    const withoutTieHigh = and(eq(file.bucket, bucket), ne(file.id, tieHigh));

    expect(await walk(undefined, withoutTieHigh)).toEqual([last, tieLow, first]);
    expect(await walk('oldest', withoutTieHigh)).toEqual([first, tieLow, last]);
  });

  it('keeps paging when the anchor row leaves the list filter between pages', async () => {
    const opening = await readPage(undefined, { limit: 2 });
    expect(opening.rows.map((row) => row.id)).toEqual([last, tieHigh]);

    const next = await readPage(encodeCursor(opening.nextCursor!), {
      limit: 2,
      where: and(eq(file.bucket, bucket), ne(file.id, tieHigh)),
    });
    expect(next.rows.map((row) => row.id)).toEqual([tieLow, first]);
    expect(next.nextCursor).toBeNull();
  });

  it('returns an empty last page when no row matches the list filters', async () => {
    const empty = await readPage(undefined, {
      limit: 2,
      where: eq(file.bucket, `${bucket}-empty`),
    });

    expect(empty).toEqual({ rows: [], hasNext: false, nextCursor: null });
  });

  it('asks the list query for one row more than the page limit', async () => {
    const probes: number[] = [];
    await readKeysetPage({
      anchor: { time: file.createdAt, id: file.id },
      limit: 3,
      read: async ({ limit }) => {
        probes.push(limit);
        return [];
      },
      rowCursor: () => ({ startTime: new Date(), id: first }),
      invalidCursor: () => new Error('unused'),
    });

    expect(probes).toEqual([4]);
  });

  it('throws the error of the caller and never runs the list query for a bad cursor', async () => {
    class ListCursorError extends Error {}
    let reads = 0;

    const attempt = readKeysetPage({
      anchor: { time: file.createdAt, id: file.id },
      cursor: decodeCursor(
        encodeCursor({ startTime: '2030-08-05T00:00:00.100Z', id: crypto.randomUUID() })
      ),
      limit: 1,
      read: async () => {
        reads += 1;
        return [];
      },
      rowCursor: () => ({ startTime: new Date(), id: first }),
      invalidCursor: () => new ListCursorError('cursor names no row'),
    });

    expect(await rejectionOf(attempt)).toBeInstanceOf(ListCursorError);
    expect(reads).toBe(0);
  });
});
