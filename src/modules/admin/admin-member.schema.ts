import { questStatus as persistedQuestStatus } from '@/database/schema/quest.schema';
import {
  memberPenaltyAddReasonCodes,
  memberPenaltyRemoveReasonCodes,
} from '@/modules/admin/member-penalty/member-penalty.policy';
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

const adminMemberModerationActionSchema = t.Union([
  t.Literal('REPORT_CASE_DISMISS'),
  t.Literal('REPORT_CASE_HIDE'),
  t.Literal('REPORT_CASE_RESTORE'),
  t.Literal('CONDUCT_REPORT_DISMISS'),
  t.Literal('CONDUCT_REPORT_UPHOLD'),
]);

export const adminMemberModerationContextFieldsSchema = t.Object({
  memberStatus: t.Union([adminMemberStatusSchema, t.Null()], {
    description: 'The current Member status. Null when the related Member record is unavailable.',
  }),
  previousReportCount: t.Union([t.Integer({ minimum: 0 }), t.Null()], {
    description:
      'The number of earlier Report Cases and Conduct Reports filed against this Member. Each Case counts once; the current Case is excluded. Null when the Member record is unavailable.',
  }),
  confirmedViolationCount: t.Union([t.Integer({ minimum: 0 }), t.Null()], {
    description:
      'The historical confirmedMisconductCount for this Member before the current Case. It includes exempt and later-reversed source events, including direct Admin Record violation actions, and excludes reversal and recalculation rows. Null when the Member record is unavailable.',
  }),
  previousModerationActions: t.Array(adminMemberModerationActionSchema, {
    maxItems: 5,
    description:
      'The five most recent earlier Report Case or Conduct Report decisions for this Member, newest first. Empty when no earlier decisions exist or the Member record is unavailable.',
  }),
});

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

const memberPenaltyLadderSchema = t.Union([t.Literal('MISCONDUCT'), t.Literal('REVIEW')]);
const memberPenaltySourceSchema = t.Union([
  t.Literal('REPORT_CASE'),
  t.Literal('CONDUCT_REPORT'),
  t.Literal('REVIEW_AVERAGE'),
  t.Literal('ADMIN'),
]);
const memberPenaltyResultSchema = t.Union([
  t.Literal('PENALTY_EXEMPT'),
  t.Literal('PENALTY_RED_FLAG'),
  t.Literal('PENALTY_TEMPORARY_BAN_7_DAYS'),
  t.Literal('PENALTY_TEMPORARY_BAN_1_MONTH'),
  t.Literal('PENALTY_PERMANENT_BAN'),
  t.Literal('PENALTY_REVERSAL'),
]);
const memberPenaltyAddResultSchema = t.Union([
  t.Literal('PENALTY_RED_FLAG'),
  t.Literal('PENALTY_TEMPORARY_BAN_7_DAYS'),
  t.Literal('PENALTY_PERMANENT_BAN'),
]);
const memberPenaltyAddReasonCodeSchema = t.Union(
  memberPenaltyAddReasonCodes.map((code) => t.Literal(code)) as [
    ReturnType<typeof t.Literal<(typeof memberPenaltyAddReasonCodes)[number]>>,
    ...ReturnType<typeof t.Literal<(typeof memberPenaltyAddReasonCodes)[number]>>[],
  ]
);
const memberPenaltyRemoveReasonCodeSchema = t.Union(
  memberPenaltyRemoveReasonCodes.map((code) => t.Literal(code)) as [
    ReturnType<typeof t.Literal<(typeof memberPenaltyRemoveReasonCodes)[number]>>,
    ...ReturnType<typeof t.Literal<(typeof memberPenaltyRemoveReasonCodes)[number]>>[],
  ]
);

const adminMemberPenaltyHistoryItemSchema = t.Object({
  recordId: uuid,
  ladder: memberPenaltyLadderSchema,
  source: memberPenaltySourceSchema,
  sourceDisplayId: t.Union([t.String({ pattern: '^(RPT|CND|QST)-[0-9]{6,}$' }), t.Null()]),
  sequenceNumber: t.Integer({ minimum: 1 }),
  result: memberPenaltyResultSchema,
  actor: t.Object({
    type: t.Union([t.Literal('ADMIN'), t.Literal('SYSTEM')]),
    displayName: t.String(),
  }),
  reasonCode: t.String(),
  adminNote: t.Union([t.String({ minLength: 1, maxLength: 200 }), t.Null()]),
  createdAt: dateTime,
  reviewRating: t.Union([t.Integer({ minimum: 1, maximum: 5 }), t.Null()]),
  isEffective: t.Boolean(),
  isEffectiveActiveMisconductPenalty: t.Boolean(),
  reversal: t.Union([
    t.Object({
      relation: t.Union([t.Literal('REVERSAL_OF'), t.Literal('REVERSED_BY')]),
      sequenceNumber: t.Integer({ minimum: 1 }),
      result: memberPenaltyResultSchema,
      createdAt: dateTime,
    }),
    t.Null(),
  ]),
  recalculatedFrom: t.Union([
    t.Object({
      sequenceNumber: t.Integer({ minimum: 1 }),
      result: memberPenaltyResultSchema,
      createdAt: dateTime,
    }),
    t.Null(),
  ]),
  replacedBy: t.Union([
    t.Object({
      sequenceNumber: t.Integer({ minimum: 1 }),
      result: memberPenaltyResultSchema,
      createdAt: dateTime,
    }),
    t.Null(),
  ]),
});

export const adminMemberPenaltyHistoryResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    member: adminMemberProfileIdentitySchema,
    confirmedMisconductCount: t.Integer({ minimum: 0 }),
    effectiveActiveMisconductPenaltyCount: t.Integer({ minimum: 0 }),
    reviewLadderRecordCount: t.Integer({ minimum: 0 }),
    versionToken: t.Integer({ minimum: 0 }),
    items: t.Array(adminMemberPenaltyHistoryItemSchema),
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
export type AdminMemberPenaltyHistoryData = Static<
  typeof adminMemberPenaltyHistoryResponseSchema
>['data'];

export const adminMemberPenaltyAddBodySchema = t.Object({
  expectedVersionToken: t.Integer({ minimum: 0 }),
  result: t.Optional(memberPenaltyAddResultSchema),
  reasonCode: memberPenaltyAddReasonCodeSchema,
  adminNote: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
});

export const adminMemberPenaltyRemoveBodySchema = t.Object({
  expectedVersionToken: t.Integer({ minimum: 0 }),
  recordId: uuid,
  reasonCode: memberPenaltyRemoveReasonCodeSchema,
  adminNote: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
});

export const adminMemberPenaltyCommandResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    command: t.Object({
      kind: t.Union([t.Literal('ADD'), t.Literal('REMOVE')]),
      outcome: t.Union([t.Literal('ADDED'), t.Literal('EXEMPTED'), t.Literal('REMOVED')]),
      recordId: uuid,
      commandRecordId: uuid,
      result: memberPenaltyResultSchema,
      versionToken: t.Integer({ minimum: 0 }),
    }),
  }),
});

export type AdminMemberPenaltyAddBody = Static<typeof adminMemberPenaltyAddBodySchema>;
export type AdminMemberPenaltyRemoveBody = Static<typeof adminMemberPenaltyRemoveBodySchema>;
export type AdminMemberPenaltyCommandData = Static<
  typeof adminMemberPenaltyCommandResponseSchema
>['data'];

export const adminMemberReviewsQuerySchema = t.Object({
  rating: t.Optional(t.Integer({ minimum: 1, maximum: 5 })),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: MAX_PAGE_LIMIT })),
  cursor: t.Optional(t.String()),
});

export const adminMemberReviewItemSchema = t.Object({
  id: uuid,
  rating: t.Integer({ minimum: 1, maximum: 5 }),
  comment: t.Union([t.String(), t.Null()]),
  createdAt: dateTime,
  updatedAt: dateTime,
  reviewer: t.Object({
    displayId: t.String({ pattern: '^MEM-[0-9]{6,}$' }),
    name: t.String(),
  }),
  quest: t.Object({
    displayId: t.String({ pattern: '^QST-[0-9]{6,}$' }),
    title: t.String(),
    questStatus: t.String(),
  }),
});

export const adminMemberReviewsResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    items: t.Array(adminMemberReviewItemSchema),
    nextCursor: t.Union([t.String(), t.Null()]),
    totalCount: t.Integer({ minimum: 0 }),
  }),
});

export type AdminMemberReviewsQuery = Static<typeof adminMemberReviewsQuerySchema>;
export type AdminMemberReviewsData = Static<typeof adminMemberReviewsResponseSchema>['data'];

export type AdminMemberParams = Static<typeof adminMemberParamsSchema>;
export type AdminMemberListItem = Static<typeof adminMemberListItemSchema>;
export type AdminMemberStatus = Static<typeof adminMemberStatusSchema>;
export type AdminMemberModerationAction = Static<typeof adminMemberModerationActionSchema>;
export type AdminMemberModerationContextFields = Static<
  typeof adminMemberModerationContextFieldsSchema
>;
export type AdminMemberListQuery = Static<typeof adminMemberListQuerySchema>;
export type AdminMemberListData = Static<typeof adminMemberListResponseSchema>['data'];
export type AdminMemberDetailData = Static<typeof adminMemberDetailResponseSchema>['data'];

const adminMemberHistoryRoleSchema = t.Union([t.Literal('HIRER'), t.Literal('WORKER')], {
  description: 'The Member role in each history row.',
});
type AdminMemberHistoryQuestStatus = (typeof persistedQuestStatus.enumValues)[number];
const adminMemberHistoryQuestStatusSchema = t.Union(
  persistedQuestStatus.enumValues.map((value) => t.Literal(value)) as [
    ReturnType<typeof t.Literal<AdminMemberHistoryQuestStatus>>,
    ...ReturnType<typeof t.Literal<AdminMemberHistoryQuestStatus>>[],
  ],
  { description: 'The current Quest State.' }
);
const adminMemberHistoryAssignmentStatusSchema = t.Union(
  [
    t.Literal('ASSIGNMENT_ACTIVE'),
    t.Literal('ASSIGNMENT_COMPLETED'),
    t.Literal('ASSIGNMENT_INCOMPLETE'),
    t.Literal('ASSIGNMENT_CANCELLED'),
  ],
  { description: 'The current Assignment status.' }
);

export const adminMemberHistoryQuerySchema = t.Object({
  role: t.Optional(adminMemberHistoryRoleSchema),
  questStatus: t.Optional(adminMemberHistoryQuestStatusSchema),
  assignmentStatus: t.Optional(adminMemberHistoryAssignmentStatusSchema),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: MAX_PAGE_LIMIT })),
  cursor: t.Optional(t.String()),
});

const adminMemberHistoryAssignmentStatusChangedAtSchema = t.Union([dateTime, t.Null()], {
  description:
    'Current Assignment status time. Sources include Assignment events, Proof Submission reviews, completion confirmations, and terminal Quest State events. Null when no event time is recorded.',
});
const adminMemberHistoryQuestStatusChangedAtSchema = t.Union([dateTime, t.Null()], {
  description:
    'Time the current Quest State was entered. Uses a Quest State event when available and persisted terminal-state events otherwise. Null when no event time is recorded.',
});

const adminMemberHistoryRelatedMemberSchema = t.Object({
  role: adminMemberHistoryRoleSchema,
  member: t.Object({
    id: t.String({
      format: 'uuid',
      description: 'Internal API reference. Use displayId as the visible Member identifier.',
    }),
    displayId: t.String({
      pattern: '^MEM-[0-9]{6,}$',
      description: 'Visible Member Display ID.',
    }),
    firstName: t.String(),
    lastName: t.String(),
  }),
  assignmentStatus: t.Union([adminMemberHistoryAssignmentStatusSchema, t.Null()]),
  assignmentCreatedAt: t.Union([dateTime, t.Null()]),
  startedAt: t.Union([dateTime, t.Null()]),
  assignmentStatusChangedAt: adminMemberHistoryAssignmentStatusChangedAtSchema,
});

const adminMemberHistoryItemSchema = t.Object({
  role: adminMemberHistoryRoleSchema,
  createdAt: dateTime,
  assignmentStatus: t.Union([adminMemberHistoryAssignmentStatusSchema, t.Null()]),
  startedAt: t.Union([dateTime, t.Null()]),
  assignmentStatusChangedAt: adminMemberHistoryAssignmentStatusChangedAtSchema,
  quest: t.Object({
    id: t.String({
      format: 'uuid',
      description: 'Internal API reference. Use displayId as the visible Quest identifier.',
    }),
    displayId: t.String({
      pattern: '^QST-[0-9]{6,}$',
      description: 'Visible Quest Display ID.',
    }),
    title: t.String(),
    questStatus: adminMemberHistoryQuestStatusSchema,
    createdAt: dateTime,
    questStatusChangedAt: adminMemberHistoryQuestStatusChangedAtSchema,
  }),
  relatedMembers: t.Array(adminMemberHistoryRelatedMemberSchema),
});

export const adminMemberHistoryResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    member: adminMemberProfileIdentitySchema,
    items: t.Array(adminMemberHistoryItemSchema, { maxItems: MAX_PAGE_LIMIT }),
    totalCount: t.Integer({ minimum: 0 }),
    nextCursor: t.Union([t.String(), t.Null()]),
  }),
});

export type AdminMemberHistoryQuery = Static<typeof adminMemberHistoryQuerySchema>;
export type AdminMemberHistoryData = Static<typeof adminMemberHistoryResponseSchema>['data'];
export type AdminMemberHistoryItem = AdminMemberHistoryData['items'][number];
export type AdminMemberHistoryRelatedMember = AdminMemberHistoryItem['relatedMembers'][number];
