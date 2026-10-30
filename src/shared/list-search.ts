import { sql, type SQLWrapper } from 'drizzle-orm';

export const containsLikePattern = (value: string): string =>
  `%${value.replace(/[\\%_]/g, '\\$&')}%`;

export const containsLikeQueryPattern = (query: string | undefined): string | undefined => {
  const normalized = query?.trim();
  return normalized ? containsLikePattern(normalized) : undefined;
};

export const buildStatusCounts = <Status extends string>(
  statuses: readonly Status[],
  rows: readonly { status: Status; count: number }[]
): Record<Status, number> => {
  const counts = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<
    Status,
    number
  >;
  for (const row of rows) counts[row.status] = row.count;
  return counts;
};

export const ilikeContains = (value: SQLWrapper, pattern: string) =>
  sql`${value} ILIKE ${pattern} ESCAPE ${'\\'}`;

export const isoDateSearchText = (value: SQLWrapper) =>
  sql<string>`to_char(${value} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
