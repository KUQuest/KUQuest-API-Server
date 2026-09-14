import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { paymentTopUps } from '@/database/schema/payment.schema';
import { CursorInputError, decodeCursor, encodeCursor } from '@/shared/cursor';
import type { CursorPayload } from '@/shared/cursor';

import { and, desc, eq, sql } from 'drizzle-orm';

import type { AdminTopUpListItem, AdminTopUpListQuery } from './top-up.admin.schema';

export type AdminTopUpListPage = {
  items: AdminTopUpListItem[];
  nextCursor: string | null;
};

const assertCursorAnchor = async (cursor: CursorPayload | undefined): Promise<void> => {
  if (!cursor) return;

  const [anchor] = await db
    .select({ id: paymentTopUps.id, createdAt: paymentTopUps.createdAt })
    .from(paymentTopUps)
    .where(eq(paymentTopUps.id, cursor.id));
  const cursorTime = new Date(cursor.startTime);
  if (!anchor || anchor.createdAt.getTime() !== cursorTime.getTime()) {
    throw new CursorInputError('INVALID_CURSOR', 'cursor does not match a Top-Up');
  }
};

export const listAdminTopUps = async (
  query: AdminTopUpListQuery = {}
): Promise<AdminTopUpListPage> => {
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
  const parsed = query.cursor ? decodeCursor(query.cursor) : undefined;
  await assertCursorAnchor(parsed);

  // PostgreSQL stores timestamps with microsecond precision, while the shared
  // cursor serializes a JavaScript Date at millisecond precision. Read the
  // cursor row inside the comparison so the database keeps the exact boundary.
  const cursorAnchor = parsed
    ? sql`(select ${paymentTopUps.createdAt}, ${paymentTopUps.id} from ${paymentTopUps} where ${paymentTopUps.id} = ${parsed.id})`
    : undefined;
  const cursorCondition = cursorAnchor
    ? sql`(${paymentTopUps.createdAt}, ${paymentTopUps.id}) < ${cursorAnchor}`
    : undefined;

  const conditions = [];
  if (cursorCondition) {
    conditions.push(cursorCondition);
  }
  if (query.status) {
    conditions.push(eq(paymentTopUps.topUpStatus, query.status));
  }
  if (query.userId) {
    conditions.push(eq(paymentTopUps.userId, query.userId));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      id: paymentTopUps.id,
      userId: paymentTopUps.userId,
      topUpStatus: paymentTopUps.topUpStatus,
      creditSatang: paymentTopUps.creditSatang,
      providerFeeSatang: paymentTopUps.providerFeeSatang,
      providerTaxSatang: paymentTopUps.providerTaxSatang,
      paymentTotalSatang: paymentTopUps.paymentTotalSatang,
      providerChannelCode: paymentTopUps.providerChannelCode,
      providerReference: paymentTopUps.providerReference,
      qrExpiresAt: paymentTopUps.qrExpiresAt,
      createdAt: paymentTopUps.createdAt,
      updatedAt: paymentTopUps.updatedAt,
      firstName: authUser.firstName,
      lastName: authUser.lastName,
      studentId: authUser.studentId,
    })
    .from(paymentTopUps)
    .innerJoin(authUser, eq(paymentTopUps.userId, authUser.id))
    .where(whereClause)
    .orderBy(desc(paymentTopUps.createdAt), desc(paymentTopUps.id))
    .limit(limit + 1);

  const hasNextPage = rows.length > limit;
  const pageRows = hasNextPage ? rows.slice(0, limit) : rows;

  let nextCursor: string | null = null;
  if (hasNextPage && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1];
    nextCursor = encodeCursor({
      id: last.id,
      startTime: last.createdAt.toISOString(),
    });
  }

  const items: AdminTopUpListItem[] = pageRows.map((r) => ({
    id: r.id,
    userId: r.userId,
    member: {
      firstName: r.firstName,
      lastName: r.lastName,
      studentId: r.studentId,
    },
    topUpStatus: r.topUpStatus,
    creditAmountSatang: r.creditSatang,
    providerFeeSatang: r.providerFeeSatang,
    providerTaxSatang: r.providerTaxSatang,
    paymentTotalSatang: r.paymentTotalSatang,
    paymentMethod: r.providerChannelCode ?? 'PROMPTPAY',
    providerReference: r.providerReference,
    expiresAt: (r.qrExpiresAt ?? r.createdAt).toISOString(),
    paidAt: r.topUpStatus === 'PAID' ? r.updatedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  }));

  return {
    items,
    nextCursor,
  };
};
