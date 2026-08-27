import { t } from 'elysia';

export const questReviewParamsSchema = t.Object({
  questId: t.String({ format: 'uuid' }),
});

export const questReviewDetailParamsSchema = t.Object({
  questId: t.String({ format: 'uuid' }),
  reviewId: t.String({ format: 'uuid' }),
});

export const questReviewCreateSchema = t.Object(
  {
    revieweeId: t.Optional(t.String({ format: 'uuid' })),
    rating: t.Integer({ minimum: 1, maximum: 5 }),
    comment: t.Optional(t.String({ minLength: 1, maxLength: 1000, pattern: '\\S' })),
  },
  { additionalProperties: false },
);

export const questReviewUpdateSchema = t.Object(
  {
    rating: t.Optional(t.Integer({ minimum: 1, maximum: 5 })),
    comment: t.Optional(t.String({ minLength: 1, maxLength: 1000, pattern: '\\S' })),
  },
  { additionalProperties: false },
);

export const questReviewResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    id: t.String({ format: 'uuid' }),
    questId: t.String({ format: 'uuid' }),
    reviewerId: t.String({ format: 'uuid' }),
    revieweeId: t.String({ format: 'uuid' }),
    rating: t.Integer({ minimum: 1, maximum: 5 }),
    comment: t.Nullable(t.String()),
    createdAt: t.String({ format: 'date-time' }),
    updatedAt: t.String({ format: 'date-time' }),
  }),
});

export type QuestReviewInput = typeof questReviewCreateSchema.static;
