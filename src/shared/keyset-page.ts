import { db } from '@/database/client';

import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

import type { CursorPayload } from './cursor';

export type KeysetSort = 'newest' | 'oldest';

/**
 * The columns a cursor anchors on: the paging timestamp and the identity tiebreaker. Both belong
 * to the table that the reader pages, and the reader reads that table off the timestamp column.
 */
export type KeysetAnchor = { time: PgColumn; id: PgColumn };

export type KeysetPageRequest<TRow> = {
  anchor: KeysetAnchor;
  cursor?: CursorPayload | undefined;
  /** Rows per page. Check it against the page-limit rule with `parsePageLimit` first. */
  limit: number;
  sort?: KeysetSort;
  /** The list filters, without the cursor boundary. */
  where?: SQL | undefined;
  /** Runs the list query with the boundary, the order, and the probe limit of this reader. */
  read: (page: { where: SQL | undefined; orderBy: SQL[]; limit: number }) => Promise<TRow[]>;
  /** Reads the cursor pair out of a page row. */
  rowCursor: (row: TRow) => { startTime: Date; id: string };
  /** The error of the calling module for a cursor that names no row. */
  invalidCursor: () => Error;
};

export type KeysetPage<TRow> = {
  rows: TRow[];
  hasNext: boolean;
  nextCursor: Omit<CursorPayload, 'v'> | null;
};

/**
 * Reads one keyset page.
 *
 * PostgreSQL keeps a `defaultNow()` timestamp at microsecond precision, and the shared cursor
 * carries a JavaScript `Date` at millisecond precision. So the page boundary compares row-wise
 * against the anchor row that the database reads back inside the query, never against the
 * millisecond value from the cursor text (`CODESTYLES.md` §Cursor paging). A cursor whose anchor
 * row is gone, or whose millisecond no longer matches the anchor row, is rejected with the error
 * of the calling module. It never reports an empty page.
 */
export const readKeysetPage = async <TRow>({
  anchor,
  cursor,
  limit,
  sort = 'newest',
  where,
  read,
  rowCursor,
  invalidCursor,
}: KeysetPageRequest<TRow>): Promise<KeysetPage<TRow>> => {
  if (cursor) {
    const [matched] = await db
      .select({ anchored: sql<number>`1` })
      .from(anchor.time.table)
      .where(
        and(
          eq(anchor.id, cursor.id),
          sql`date_trunc('milliseconds', ${anchor.time}) = ${cursor.startTime}::timestamptz`
        )
      );
    if (!matched) throw invalidCursor();
  }

  const anchorRow = cursor
    ? sql`(select ${anchor.time}, ${anchor.id} from ${anchor.time.table} where ${anchor.id} = ${cursor.id})`
    : undefined;
  const boundary = anchorRow
    ? sort === 'oldest'
      ? sql`(${anchor.time}, ${anchor.id}) > ${anchorRow}`
      : sql`(${anchor.time}, ${anchor.id}) < ${anchorRow}`
    : undefined;

  const probe = await read({
    where: and(where, boundary),
    orderBy:
      sort === 'oldest' ? [asc(anchor.time), asc(anchor.id)] : [desc(anchor.time), desc(anchor.id)],
    limit: limit + 1,
  });

  const hasNext = probe.length > limit;
  const rows = hasNext ? probe.slice(0, limit) : probe;
  const last = rows[rows.length - 1];
  const tail = hasNext && last ? rowCursor(last) : undefined;

  return {
    rows,
    hasNext,
    nextCursor: tail ? { startTime: tail.startTime.toISOString(), id: tail.id } : null,
  };
};
