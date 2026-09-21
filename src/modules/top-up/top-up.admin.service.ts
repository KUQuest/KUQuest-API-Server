import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { paymentTopUps } from '@/database/schema/payment.schema';
import { CursorInputError, decodeCursor, encodeCursor, parsePageLimit } from '@/shared/cursor';
import { readKeysetPage } from '@/shared/keyset-page';

import { and, eq } from 'drizzle-orm';

import type { AdminTopUpListItem, AdminTopUpListQuery } from './top-up.admin.schema';

export type AdminTopUpListPage = {
  items: AdminTopUpListItem[];
  nextCursor: string | null;
};

export const listAdminTopUps = async (
  query: AdminTopUpListQuery = {}
): Promise<AdminTopUpListPage> => {
  const limit = parsePageLimit(query.limit);
  const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;

  const page = await readKeysetPage({
    anchor: { time: paymentTopUps.createdAt, id: paymentTopUps.id },
    cursor,
    limit,
    where: and(
      query.status ? eq(paymentTopUps.topUpStatus, query.status) : undefined,
      query.userId ? eq(paymentTopUps.userId, query.userId) : undefined
    ),
    read: ({ where, orderBy, limit: probe }) =>
      db
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
        .where(where)
        .orderBy(...orderBy)
        .limit(probe),
    rowCursor: (row) => ({ startTime: row.createdAt, id: row.id }),
    invalidCursor: () => new CursorInputError('INVALID_CURSOR', 'cursor does not match a Top-Up'),
  });

  const nextCursor = page.nextCursor ? encodeCursor(page.nextCursor) : null;

  const items: AdminTopUpListItem[] = page.rows.map((r) => ({
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
