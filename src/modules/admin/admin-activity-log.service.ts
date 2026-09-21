import { db } from '@/database/client';
import { adminAction } from '@/database/schema/admin.schema';
import { authAdmin } from '@/database/schema/auth.schema';
import { CursorInputError } from '@/shared/cursor';
import type { CursorPayload } from '@/shared/cursor';
import { readKeysetPage } from '@/shared/keyset-page';

import { and, eq } from 'drizzle-orm';

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
  const page = await readKeysetPage({
    anchor: { time: adminAction.createdAt, id: adminAction.id },
    cursor,
    limit,
    sort,
    where: and(
      action ? eq(adminAction.action, action) : undefined,
      resourceType ? eq(adminAction.resourceType, resourceType) : undefined,
      resourceId ? eq(adminAction.resourceId, resourceId) : undefined,
      adminId ? eq(adminAction.adminId, adminId) : undefined
    ),
    read: ({ where, orderBy, limit: probe }) =>
      db
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
        .where(where)
        .orderBy(...orderBy)
        .limit(probe),
    rowCursor: (row) => ({ startTime: row.createdAt, id: row.id }),
    invalidCursor: () =>
      new CursorInputError('INVALID_CURSOR', 'cursor does not match an Admin Action'),
  });

  return { items: page.rows, nextCursor: page.nextCursor };
};

export const serializeAdminActivityEntry = (entry: AdminActivityEntry) => ({
  ...entry,
  resultTimestamp: entry.resultTimestamp ? entry.resultTimestamp.toISOString() : null,
  createdAt: entry.createdAt.toISOString(),
});
