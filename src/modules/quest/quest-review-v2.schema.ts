import { t, type Static } from 'elysia';

export const questV2ReviewParamsSchema = t.Object({
  questId: t.String({ format: 'uuid' }),
});

export const questV2ReviewDetailParamsSchema = t.Object({
  questId: t.String({ format: 'uuid' }),
  reviewId: t.String({ format: 'uuid' }),
});

export const questV2ReviewHeadersSchema = t.Object(
  {
    'idempotency-key': t.String({
      minLength: 1,
      maxLength: 200,
      pattern: '\\S',
      description: 'Non-blank command identity for replay-safe Rating Review commands',
    }),
  },
  { additionalProperties: false },
);

export const questV2ReviewCreateSchema = t.Object(
  {
    revieweeId: t.Optional(t.String({ format: 'uuid' })),
    rating: t.Integer({ minimum: 1, maximum: 5 }),
    comment: t.Optional(t.String({ minLength: 1, maxLength: 1000, pattern: '\\S' })),
  },
  { additionalProperties: false },
);

export const questV2ReviewUpdateSchema = t.Object(
  {
    rating: t.Optional(t.Integer({ minimum: 1, maximum: 5 })),
    comment: t.Optional(t.String({ minLength: 1, maxLength: 1000, pattern: '\\S' })),
  },
  { additionalProperties: false, minProperties: 1 },
);

export const questV2ReviewResponseSchema = t.Object({
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

export type QuestV2ReviewParams = Static<typeof questV2ReviewParamsSchema>;
export type QuestV2ReviewDetailParams = Static<typeof questV2ReviewDetailParamsSchema>;
export type QuestV2ReviewHeaders = Static<typeof questV2ReviewHeadersSchema>;
export type QuestV2ReviewCreateInput = Static<typeof questV2ReviewCreateSchema>;
export type QuestV2ReviewUpdateInput = Static<typeof questV2ReviewUpdateSchema>;
