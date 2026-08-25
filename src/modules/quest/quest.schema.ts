import { t } from 'elysia';

const questModeSchema = t.Union([
  t.Literal('FIRST_COME_FIRST_SERVED'),
  t.Literal('CANDIDATE'),
]);

const questParticipationSchema = t.Union([t.Literal('SINGLE'), t.Literal('GROUP')]);

const locationInputSchema = t.Object(
  {
    label: t.Optional(t.Nullable(t.String({ maxLength: 100, pattern: '\\S' }))),
    address: t.Optional(t.Nullable(t.String({ maxLength: 500, pattern: '\\S' }))),
    latitude: t.Number({ minimum: -90, maximum: 90 }),
    longitude: t.Number({ minimum: -180, maximum: 180 }),
  },
  { additionalProperties: false },
);

export const questCreateSchema = t.Object(
  {
    title: t.String({ minLength: 1, maxLength: 120, pattern: '\\S' }),
    description: t.Optional(t.Nullable(t.String({ maxLength: 1000, pattern: '\\S' }))),
    condition: t.String({ minLength: 1, maxLength: 1000, pattern: '\\S' }),
    mode: questModeSchema,
    participation: questParticipationSchema,
    reward: t.Integer({ minimum: 1, maximum: 700000 }),
    headcount: t.Integer({ minimum: 1, maximum: 20 }),
    startTime: t.String({ format: 'date-time' }),
    dueAt: t.Optional(t.Nullable(t.String({ format: 'date-time' }))),
    tagId: t.Optional(t.Nullable(t.String({ format: 'uuid' }))),
    proofRequired: t.Optional(t.Boolean()),
    locations: t.Optional(t.Array(locationInputSchema, { maxItems: 10 })),
  },
  { additionalProperties: false },
);

export const questParamsSchema = t.Object({
  questId: t.String({ format: 'uuid' }),
});

export const questListQuerySchema = t.Object(
  {
    q: t.Optional(t.String({ maxLength: 200 })),
    tagId: t.Optional(t.String({ format: 'uuid' })),
    mode: t.Optional(questModeSchema),
    participation: t.Optional(questParticipationSchema),
    maxDurationMinutes: t.Optional(t.Integer({ minimum: 1 })),
    minReward: t.Optional(t.Integer({ minimum: 1, maximum: 700000 })),
    maxReward: t.Optional(t.Integer({ minimum: 1, maximum: 700000 })),
    startFrom: t.Optional(t.String({ format: 'date-time' })),
    startTo: t.Optional(t.String({ format: 'date-time' })),
    latitude: t.Optional(t.Number({ minimum: -90, maximum: 90 })),
    longitude: t.Optional(t.Number({ minimum: -180, maximum: 180 })),
    limit: t.Optional(t.Integer({ minimum: 1, maximum: 50 })),
    cursor: t.Optional(t.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const questMineQuerySchema = t.Object(
  {
    limit: t.Optional(t.Integer({ minimum: 1, maximum: 50 })),
    cursor: t.Optional(t.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const tagSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  name: t.String(),
});

const locationSchema = t.Object({
  label: t.Nullable(t.String()),
  address: t.Nullable(t.String()),
  latitude: t.Number(),
  longitude: t.Number(),
});

const imageSchema = t.Object({
  fileId: t.String({ format: 'uuid' }),
});

const questSummarySchema = t.Object({
  id: t.String({ format: 'uuid' }),
  title: t.String(),
  reward: t.Integer({ minimum: 1 }),
  tag: t.Nullable(tagSchema),
  mode: questModeSchema,
  participation: questParticipationSchema,
  headcount: t.Integer({ minimum: 1 }),
  startTime: t.String({ format: 'date-time' }),
  estimatedDurationMinutes: t.Nullable(t.Integer({ minimum: 1 })),
  hirerName: t.String(),
  location: t.Nullable(locationSchema),
  distanceKm: t.Optional(t.Nullable(t.Number({ minimum: 0 }))),
});

export const questCardSchema = t.Composite([
  questSummarySchema,
  t.Object({ tag: tagSchema }),
]);

export const questListItemSchema = t.Composite([
  questSummarySchema,
  t.Object({ questStatus: t.String() }),
]);

export const questDetailSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  title: t.String(),
  description: t.Nullable(t.String()),
  condition: t.String(),
  reward: t.Integer({ minimum: 1 }),
  tag: t.Nullable(tagSchema),
  mode: questModeSchema,
  participation: questParticipationSchema,
  questStatus: t.String(),
  headcount: t.Integer({ minimum: 1 }),
  startTime: t.String({ format: 'date-time' }),
  dueAt: t.Nullable(t.String({ format: 'date-time' })),
  estimatedDurationMinutes: t.Nullable(t.Integer({ minimum: 1 })),
  proofRequired: t.Boolean(),
  hirerName: t.String(),
  locations: t.Array(
    t.Composite([
      locationSchema,
      t.Object({ position: t.Integer({ minimum: 1 }) }),
    ]),
  ),
  images: t.Array(imageSchema),
});

export const questCreateResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({ id: t.String({ format: 'uuid' }) }),
});

export const questBoardResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    items: t.Array(questCardSchema),
    nextCursor: t.Nullable(t.String()),
  }),
});

export const questMineResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    items: t.Array(questListItemSchema),
    nextCursor: t.Nullable(t.String()),
  }),
});

export const questDetailResponseSchema = t.Object({
  success: t.Literal(true),
  data: questDetailSchema,
});

export type QuestCreateInput = typeof questCreateSchema.static;
export type QuestListQuery = typeof questListQuerySchema.static;
export type QuestMineQuery = typeof questMineQuerySchema.static;
