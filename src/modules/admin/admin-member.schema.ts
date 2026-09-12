import { t, type Static } from 'elysia';

const dateTime = t.String({ format: 'date-time' });
const uuid = t.String({ format: 'uuid' });

export const adminMemberParamsSchema = t.Object({
  id: uuid,
});

export const adminMemberListItemSchema = t.Object({
  id: uuid,
  email: t.String(),
  firstName: t.String(),
  lastName: t.String(),
  studentId: t.Union([t.String(), t.Null()]),
  telephone: t.Union([t.String(), t.Null()]),
  academicYear: t.Union([t.Integer(), t.Null()]),
  faculty: t.Union([t.String(), t.Null()]),
  department: t.Union([t.String(), t.Null()]),
  occupation: t.Union([t.String(), t.Null()]),
  wallet: t.Union([
    t.Object({
      id: uuid,
      walletStatus: t.String(),
      spendingBalanceSatang: t.Integer(),
      earningsBalanceSatang: t.Integer(),
      totalBalanceSatang: t.Integer(),
    }),
    t.Null(),
  ]),
  createdAt: dateTime,
});

export const adminMemberListQuerySchema = t.Object({
  search: t.Optional(t.String()),
  walletStatus: t.Optional(
    t.Union([
      t.Literal('ACTIVE'),
      t.Literal('FROZEN'),
      t.Literal('SUSPENDED'),
      t.Literal('CLOSED'),
    ]),
  ),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
  cursor: t.Optional(t.String()),
});

export const adminMemberListResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    items: t.Array(adminMemberListItemSchema),
    nextCursor: t.Union([t.String(), t.Null()]),
  }),
});

export const adminMemberDetailResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    member: t.Object({
      id: uuid,
      email: t.String(),
      firstName: t.String(),
      lastName: t.String(),
      studentId: t.Union([t.String(), t.Null()]),
      telephone: t.Union([t.String(), t.Null()]),
      bio: t.Union([t.String(), t.Null()]),
      academicYear: t.Union([t.Integer(), t.Null()]),
      faculty: t.Union([t.String(), t.Null()]),
      department: t.Union([t.String(), t.Null()]),
      occupation: t.Union([t.String(), t.Null()]),
      createdAt: dateTime,
    }),
    wallet: t.Union([
      t.Object({
        id: uuid,
        walletStatus: t.String(),
        spendingBalanceSatang: t.Integer(),
        earningsBalanceSatang: t.Integer(),
        fundingReservedSatang: t.Integer(),
        reservedForPayoutsSatang: t.Integer(),
        totalBalanceSatang: t.Integer(),
        projectionMatchesLedger: t.Boolean(),
      }),
      t.Null(),
    ]),
    stats: t.Object({
      questsCreatedCount: t.Integer({ minimum: 0 }),
      questsCompletedAsWorkerCount: t.Integer({ minimum: 0 }),
      reviewsReceivedCount: t.Integer({ minimum: 0 }),
      averageRating: t.Union([t.Number(), t.Null()]),
      payoutsCount: t.Integer({ minimum: 0 }),
      totalEarnedSatang: t.Integer({ minimum: 0 }),
      totalPaidOutSatang: t.Integer({ minimum: 0 }),
    }),
  }),
});

export type AdminMemberParams = Static<typeof adminMemberParamsSchema>;
export type AdminMemberListItem = Static<typeof adminMemberListItemSchema>;
export type AdminMemberListQuery = Static<typeof adminMemberListQuerySchema>;
export type AdminMemberListData = Static<typeof adminMemberListResponseSchema>['data'];
export type AdminMemberDetailData = Static<typeof adminMemberDetailResponseSchema>['data'];
