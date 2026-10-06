import { MAX_PAGE_LIMIT } from '@/shared/cursor';

import { t, type Static } from 'elysia';

const dateTime = t.String({ format: 'date-time' });
const uuid = t.String({ format: 'uuid' });
export const adminMemberStatusSchema = t.Union(
  [
    t.Literal('NORMAL'),
    t.Literal('RED_FLAG'),
    t.Literal('TEMPORARY_BAN'),
    t.Literal('PERMANENT_BAN'),
  ],
  {
    description: 'Current Member restriction status. It is separate from Wallet status.',
  }
);

export const adminMemberParamsSchema = t.Object({
  id: uuid,
});

export const adminMemberListItemSchema = t.Object({
  id: uuid,
  displayId: t.String({ pattern: '^MEM-[0-9]{6,}$' }),
  email: t.String(),
  firstName: t.String(),
  lastName: t.String(),
  studentId: t.Union([t.String(), t.Null()]),
  telephone: t.Union([t.String(), t.Null()]),
  academicYear: t.Union([t.Integer(), t.Null()]),
  faculty: t.Union([t.String(), t.Null()]),
  department: t.Union([t.String(), t.Null()]),
  occupation: t.Union([t.String(), t.Null()]),
  memberStatus: adminMemberStatusSchema,
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
    t.Union([t.Literal('ACTIVE'), t.Literal('FROZEN'), t.Literal('SUSPENDED'), t.Literal('CLOSED')])
  ),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: MAX_PAGE_LIMIT })),
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
      displayId: t.String({ pattern: '^MEM-[0-9]{6,}$' }),
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
      memberStatus: adminMemberStatusSchema,
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
export const adminMemberProfileCollectionQuerySchema = t.Object({
  limit: t.Optional(t.Integer({ minimum: 1, maximum: MAX_PAGE_LIMIT })),
  cursor: t.Optional(t.String()),
});

const adminMemberProfileIdentitySchema = t.Object({
  displayId: t.String({ pattern: '^MEM-[0-9]{6,}$' }),
});

const adminMemberProfileTagSchema = t.Object({
  name: t.String(),
});

export const adminMemberProfileTagsResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    member: adminMemberProfileIdentitySchema,
    tags: t.Array(adminMemberProfileTagSchema, { maxItems: 3 }),
  }),
});

const adminMemberWorkExperienceSchema = t.Object({
  title: t.String(),
  employmentType: t.String(),
  organization: t.Union([t.String(), t.Null()]),
  description: t.Union([t.String(), t.Null()]),
  startedAt: t.String({ format: 'date' }),
  endedAt: t.Union([t.String({ format: 'date' }), t.Null()]),
});

export const adminMemberWorkExperiencesResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    member: adminMemberProfileIdentitySchema,
    items: t.Array(adminMemberWorkExperienceSchema),
    totalCount: t.Integer({ minimum: 0 }),
    nextCursor: t.Union([t.String(), t.Null()]),
  }),
});

const adminMemberCertificateImageSchema = t.Union([
  t.Object({
    contentType: t.String(),
    sizeBytes: t.Integer({ minimum: 0 }),
  }),
  t.Null(),
]);

const adminMemberCertificateSchema = t.Object({
  name: t.String(),
  issuer: t.String(),
  issuedAt: t.String({ format: 'date' }),
  image: adminMemberCertificateImageSchema,
});

export const adminMemberCertificatesResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    member: adminMemberProfileIdentitySchema,
    items: t.Array(adminMemberCertificateSchema),
    totalCount: t.Integer({ minimum: 0 }),
    nextCursor: t.Union([t.String(), t.Null()]),
  }),
});

export type AdminMemberProfileIdentity = Static<typeof adminMemberProfileIdentitySchema>;
export type AdminMemberWorkExperienceItem = Static<typeof adminMemberWorkExperienceSchema>;
export type AdminMemberCertificateItem = Static<typeof adminMemberCertificateSchema>;

export type AdminMemberProfileCollectionQuery = Static<
  typeof adminMemberProfileCollectionQuerySchema
>;
export type AdminMemberProfileTagsData = Static<
  typeof adminMemberProfileTagsResponseSchema
>['data'];
export type AdminMemberWorkExperiencesData = Static<
  typeof adminMemberWorkExperiencesResponseSchema
>['data'];
export type AdminMemberCertificatesData = Static<
  typeof adminMemberCertificatesResponseSchema
>['data'];

export type AdminMemberParams = Static<typeof adminMemberParamsSchema>;
export type AdminMemberListItem = Static<typeof adminMemberListItemSchema>;
export type AdminMemberStatus = Static<typeof adminMemberStatusSchema>;
export type AdminMemberListQuery = Static<typeof adminMemberListQuerySchema>;
export type AdminMemberListData = Static<typeof adminMemberListResponseSchema>['data'];
export type AdminMemberDetailData = Static<typeof adminMemberDetailResponseSchema>['data'];
