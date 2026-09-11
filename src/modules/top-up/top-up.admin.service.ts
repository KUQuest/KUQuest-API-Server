import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { paymentTopUps } from '@/database/schema/payment.schema';
import { decodeCursor, encodeCursor } from '@/shared/cursor';

import { and, desc, eq, lt, or } from 'drizzle-orm';

import type {
  AdminTopUpListItem,
  AdminTopUpListQuery,
} from './top-up.admin.schema';

export type AdminTopUpListPage = {
  items: AdminTopUpListItem[];
  nextCursor: string | null;
};

export const listAdminTopUps = async (
  query: AdminTopUpListQuery = {},
): Promise<AdminTopUpListPage> => {
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
  const conditions = [];

  if (query.status) {
    conditions.push(eq(paymentTopUps.topUpStatus, query.status));
  }
  if (query.userId) {
    conditions.push(eq(paymentTopUps.userId, query.userId));
  }

  if (query.cursor) {
    const parsed = decodeCursor(query.cursor);
    if (parsed) {
      const cursorDate = new Date(parsed.startTime);
      conditions.push(
        or(
          lt(paymentTopUps.createdAt, cursorDate),
          and(
            eq(paymentTopUps.createdAt, cursorDate),
            lt(paymentTopUps.id, parsed.id),
          ),
        ),
      );
    }
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
