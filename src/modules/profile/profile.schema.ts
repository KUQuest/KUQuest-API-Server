import { certificateSchema } from '@/modules/certificate/certificate.schema';
import { portfolioItemSchema } from '@/modules/portfolio/portfolio.schema';
import { workExperienceSchema } from '@/modules/work-experience/work-experience.schema';
import { MAX_PAGE_LIMIT } from '@/shared/cursor';

import { t, type TSchema } from 'elysia';

export const avatarUploadSchema = t.Object(
  {
    avatar: t.File(),
  },
  {
    additionalProperties: false,
  }
);

const versionSchema = t.Integer({ minimum: 1 });

const departmentSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  name: t.String({ example: 'Computer Engineering' }),
  faculty: t.Object({
    name: t.String({ example: 'Engineering' }),
  }),
});

const avatarSchema = t.Object({
  fileId: t.String({ format: 'uuid' }),
  url: t.String({ format: 'uri' }),
});

export const profileAvatarSchema = t.Nullable(avatarSchema);

export const avatarUploadResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    fileId: t.Nullable(t.String({ format: 'uuid' })),
    version: versionSchema,
    avatar: profileAvatarSchema,
  }),
});

const occupationSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  name: t.Union([t.Literal('Staff'), t.Literal('Lecturer'), t.Literal('Student')]),
});

const tagSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  name: t.String(),
});

const nameSchema = t.String({ minLength: 1, maxLength: 100, pattern: '\\S' });

export const profileUpdateSchema = t.Object(
  {
    firstName: t.Optional(nameSchema),
    lastName: t.Optional(nameSchema),
    bio: t.Optional(t.String({ minLength: 1, maxLength: 1000, pattern: '\\S' })),
    telephone: t.Optional(t.String({ pattern: '^0[0-9]{9}$', example: '0800000000' })),
    departmentId: t.Optional(t.String({ format: 'uuid' })),
  },
  { additionalProperties: false }
);

export const profileResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    version: versionSchema,
    email: t.String({ format: 'email', example: 'student@ku.th' }),
    firstName: t.String(),
    lastName: t.String(),
    bio: t.Nullable(t.String()),
    telephone: t.Nullable(t.String({ example: '0800000000' })),
    studentId: t.Nullable(t.String({ example: '6500000000' })),
    academicYear: t.Nullable(t.Integer()),
    department: t.Nullable(departmentSchema),
    avatar: t.Nullable(avatarSchema),
    occupation: t.Nullable(occupationSchema),
    tags: t.Array(tagSchema, { maxItems: 3 }),
  }),
});

const ratingDistributionSchema = t.Object({
  '5': t.Integer({ minimum: 0 }),
  '4': t.Integer({ minimum: 0 }),
  '3': t.Integer({ minimum: 0 }),
  '2': t.Integer({ minimum: 0 }),
  '1': t.Integer({ minimum: 0 }),
});

export const reputationResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    totalQuests: t.Integer({ minimum: 0 }),
    rating: t.Object({
      average: t.Nullable(t.Number({ minimum: 0, maximum: 5 })),
      count: t.Integer({ minimum: 0 }),
      distribution: ratingDistributionSchema,
    }),
  }),
});

const penaltyLadderStatusSchema = <T extends TSchema>(nextResult: T) =>
  t.Object({
    strikeCount: t.Integer({ minimum: 0 }),
    ladderLength: t.Integer({ minimum: 1 }),
    nextResult,
  });

export const penaltyStatusResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    misconduct: penaltyLadderStatusSchema(
      t.Union([
        t.Literal('PENALTY_RED_FLAG'),
        t.Literal('PENALTY_TEMPORARY_BAN_7_DAYS'),
        t.Literal('PENALTY_PERMANENT_BAN'),
      ])
    ),
    review: penaltyLadderStatusSchema(
      t.Union([
        t.Literal('PENALTY_TEMPORARY_BAN_7_DAYS'),
        t.Literal('PENALTY_TEMPORARY_BAN_1_MONTH'),
        t.Literal('PENALTY_PERMANENT_BAN'),
      ])
    ),
    redFlagExpiresAt: t.Nullable(t.String({ format: 'date-time' })),
  }),
});

const reviewSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  reviewer: t.Object({
    displayName: t.String(),
    avatar: t.Optional(t.Nullable(t.Object({ url: t.String({ format: 'uri' }) }))),
  }),
  rating: t.Integer({ minimum: 1, maximum: 5 }),
  comment: t.Nullable(t.String()),
  createdAt: t.String({ format: 'date-time' }),
  quest: t.Optional(
    t.Nullable(
      t.Object({
        id: t.String({ format: 'uuid' }),
        title: t.String(),
      })
    )
  ),
});

export const reviewsQuerySchema = t.Object(
  {
    rating: t.Optional(t.Integer({ minimum: 1, maximum: 5 })),
    limit: t.Optional(t.Integer({ minimum: 1, maximum: MAX_PAGE_LIMIT })),
    cursor: t.Optional(t.String()),
  },
  { additionalProperties: false }
);

export const reviewsResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    items: t.Array(reviewSchema),
    total: t.Integer({ minimum: 0 }),
    nextCursor: t.Nullable(t.String()),
  }),
});

export const publicProfileParamsSchema = t.Object({
  userId: t.String({ format: 'uuid' }),
});

export const publicProfileResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    version: versionSchema,
    firstName: t.String(),
    lastName: t.String(),
    bio: t.Nullable(t.String()),
    academicYear: t.Nullable(t.Integer()),
    redFlagged: t.Boolean(),
    department: t.Nullable(departmentSchema),
    avatar: t.Nullable(avatarSchema),
    occupation: t.Nullable(occupationSchema),
    reputation: t.Object({
      totalQuests: t.Integer({ minimum: 0 }),
      rating: t.Object({
        average: t.Nullable(t.Number({ minimum: 0, maximum: 5 })),
      }),
    }),
    experience: t.Array(workExperienceSchema),
    portfolio: t.Array(portfolioItemSchema),
    certificates: t.Array(certificateSchema),
  }),
});
