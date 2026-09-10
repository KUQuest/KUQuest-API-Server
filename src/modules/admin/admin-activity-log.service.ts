import { db } from '@/database/client';
import { adminAction } from '@/database/schema/admin.schema';
import { authAdmin } from '@/database/schema/auth.schema';
import { CursorInputError } from '@/shared/cursor';
import type { CursorPayload } from '@/shared/cursor';

import { and, asc, desc, eq, sql as drizzleSql } from 'drizzle-orm';

export type AdminActivityEntry = {
  id: string;
  admin: { id: string; firstName: string; lastName: string };
  action: string;
  resourceType: string;
  resourceId: string;
  reasonCode: string | null;
  reasonCatalogVersion: number;
  resultVersion: number | null;
  resultTimestamp: Date | null;
  createdAt: Date;
};

export type ListAdminActivityInput = {
  action?: string;
  resourceType?: string;
  resourceId?: string;
  adminId?: string;
  limit?: number;
  cursor?: CursorPayload;
  sort?: 'newest' | 'oldest';
};

export type AdminActivityPage = {
  items: AdminActivityEntry[];
  nextCursor: Omit<CursorPayload, 'v'> | null;
};

const assertCursorAnchor = async (cursor: CursorPayload | undefined): Promise<void> => {
  if (!cursor) return;

  const [anchor] = await db
    .select({ id: adminAction.id, createdAt: adminAction.createdAt })
    .from(adminAction)
    .where(eq(adminAction.id, cursor.id));
  const cursorTime = new Date(cursor.startTime);
  if (!anchor || anchor.createdAt.getTime() !== cursorTime.getTime()) {
    throw new CursorInputError('INVALID_CURSOR', 'cursor does not match an Admin Action');
  }
};

/**
 * Lists the safe columns of immutable Admin Actions. Evidence and request
 * data are intentionally not selected from the database.
 */
export const listAdminActivity = async ({
  action,
  resourceType,
  resourceId,
  adminId,
  limit = 20,
  cursor,
  sort = 'newest',
}: ListAdminActivityInput = {}): Promise<AdminActivityPage> => {
  await assertCursorAnchor(cursor);

  // PostgreSQL stores timestamps with microsecond precision, while the shared
  // cursor serializes a JavaScript Date at millisecond precision. Read the
  // cursor row inside the comparison so the database keeps the exact boundary.
  const cursorAnchor = cursor
    ? drizzleSql`(select ${adminAction.createdAt}, ${adminAction.id} from ${adminAction} where ${adminAction.id} = ${cursor.id})`
    : undefined;
  const cursorCondition = cursorAnchor
    ? sort === 'oldest'
      ? drizzleSql`(${adminAction.createdAt}, ${adminAction.id}) > ${cursorAnchor}`
      : drizzleSql`(${adminAction.createdAt}, ${adminAction.id}) < ${cursorAnchor}`
    : undefined;

  const rows = await db
    .select({
      id: adminAction.id,
      admin: {
        id: authAdmin.id,
        firstName: authAdmin.firstName,
        lastName: authAdmin.lastName,
      },
      action: adminAction.action,
      resourceType: adminAction.resourceType,
      resourceId: adminAction.resourceId,
      reasonCode: adminAction.reasonCode,
      reasonCatalogVersion: adminAction.reasonCatalogVersion,
      resultVersion: adminAction.resultVersion,
      resultTimestamp: adminAction.resultTimestamp,
      createdAt: adminAction.createdAt,
    })
    .from(adminAction)
    .innerJoin(authAdmin, eq(authAdmin.id, adminAction.adminId))
    .where(and(
      action ? eq(adminAction.action, action) : undefined,
      resourceType ? eq(adminAction.resourceType, resourceType) : undefined,
      resourceId ? eq(adminAction.resourceId, resourceId) : undefined,
      adminId ? eq(adminAction.adminId, adminId) : undefined,
      cursorCondition,
    ))
    .orderBy(
      sort === 'oldest' ? asc(adminAction.createdAt) : desc(adminAction.createdAt),
      sort === 'oldest' ? asc(adminAction.id) : desc(adminAction.id),
    )
    .limit(limit + 1);

  const hasNext = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];

  return {
    items,
    nextCursor: hasNext && last
      ? { startTime: last.createdAt.toISOString(), id: last.id }
      : null,
  };
};

export const serializeAdminActivityEntry = (entry: AdminActivityEntry) => ({
  ...entry,
  resultTimestamp: entry.resultTimestamp ? entry.resultTimestamp.toISOString() : null,
  createdAt: entry.createdAt.toISOString(),
});
