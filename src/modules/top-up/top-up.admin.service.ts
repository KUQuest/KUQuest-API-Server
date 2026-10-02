import { formatTopUpDisplayId } from '@/modules/admin/admin-display-id';
import { MoneyDomainError } from '@/modules/wallet';
import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { paymentTopUps, type TopUpStatus } from '@/database/schema/payment.schema';
import { CursorInputError, decodeCursor, encodeCursor, parsePageLimit } from '@/shared/cursor';
import { readKeysetPage } from '@/shared/keyset-page';

import { and, eq } from 'drizzle-orm';

import type { AdminTopUpListItem, AdminTopUpListQuery } from './top-up.admin.schema';

export type AdminTopUpListPage = {
  items: AdminTopUpListItem[];
  nextCursor: string | null;
};

const adminTopUpColumns = {
  id: paymentTopUps.id,
  publicSequence: paymentTopUps.publicSequence,
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
};

type AdminTopUpRow = {
  id: string;
  publicSequence: number;
  userId: string;
  topUpStatus: TopUpStatus;
  creditSatang: number;
  providerFeeSatang: number;
  providerTaxSatang: number;
  paymentTotalSatang: number;
  providerChannelCode: string | null;
  providerReference: string | null;
  qrExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  firstName: string;
  lastName: string;
  studentId: string | null;
};

const adminTopUpItemFromRow = (r: AdminTopUpRow): AdminTopUpListItem => {
  const expiresAt = (r.qrExpiresAt ?? r.createdAt).toISOString();
  const paidAt = r.topUpStatus === 'PAID' ? r.updatedAt.toISOString() : null;

  return {
    id: r.id,
    displayId: formatTopUpDisplayId(r.publicSequence),
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
    expiresAt,
    paidAt,
    createdAt: r.createdAt.toISOString(),
  };
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
        .select(adminTopUpColumns)
        .from(paymentTopUps)
        .innerJoin(authUser, eq(paymentTopUps.userId, authUser.id))
        .where(where)
        .orderBy(...orderBy)
        .limit(probe),
    rowCursor: (row) => ({ startTime: row.createdAt, id: row.id }),
    invalidCursor: () => new CursorInputError('INVALID_CURSOR', 'cursor does not match a Top-Up'),
  });

  const nextCursor = page.nextCursor ? encodeCursor(page.nextCursor) : null;

  const items: AdminTopUpListItem[] = page.rows.map(adminTopUpItemFromRow);

  return {
    items,
    nextCursor,
  };
};

export const getAdminTopUp = async (topUpId: string): Promise<AdminTopUpListItem> => {
  const [row] = await db
    .select(adminTopUpColumns)
    .from(paymentTopUps)
    .innerJoin(authUser, eq(paymentTopUps.userId, authUser.id))
    .where(eq(paymentTopUps.id, topUpId))
    .limit(1);
  if (!row) throw new MoneyDomainError('TOP_UP_NOT_FOUND', 'Top-up does not exist.');
  return adminTopUpItemFromRow(row);
};
