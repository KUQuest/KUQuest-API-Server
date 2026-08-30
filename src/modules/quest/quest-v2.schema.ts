import { rejectUnknownFields } from '@/shared/reject-unknown-fields';

import { t, type Static } from 'elysia';

import { questV2Modes, questV2Participations, questV2States } from './quest-v2.contract';

const questV2ModeSchema = t.Union([
  t.Literal(questV2Modes[0]),
  t.Literal(questV2Modes[1]),
]);

const questV2ParticipationSchema = t.Union([
  t.Literal(questV2Participations[0]),
  t.Literal(questV2Participations[1]),
]);

const questV2StateSchema = t.Union([
  t.Literal(questV2States[0]),
  t.Literal(questV2States[1]),
  t.Literal(questV2States[2]),
  t.Literal(questV2States[3]),
  t.Literal(questV2States[4]),
  t.Literal(questV2States[5]),
  t.Literal(questV2States[6]),
]);

const isoDateTimeWithTimezoneSchema = t.String({
  format: 'date-time',
  pattern: '(?:Z|[+-]\\d{2}:\\d{2})$',
});
const titleSchema = t.String({ minLength: 1, maxLength: 120, pattern: '\\S' });
const descriptionSchema = t.Nullable(t.String({ maxLength: 1000, pattern: '\\S' }));
const conditionItemsSchema = t.Array(
  t.String({ minLength: 1, maxLength: 255, pattern: '\\S' }),
  { minItems: 1 },
);
const locationSchema = t.Object(
  {
    label: t.Optional(t.Nullable(t.String({ maxLength: 100, pattern: '\\S' }))),
  },
  { additionalProperties: false },
);
const questFundingTotalSchema = t.Number({
  minimum: 1,
  maximum: 700000,
  description:
    'Inclusive Quest Funding Total in Baht with exact satang precision (at most two decimal places).',
});

export const questV2CreateSchema = t.Object(
  {
    title: titleSchema,
    description: t.Optional(descriptionSchema),
    condition: t.Object(
      { items: conditionItemsSchema },
      { additionalProperties: false },
    ),
    mode: questV2ModeSchema,
    participation: questV2ParticipationSchema,
    questFundingTotal: questFundingTotalSchema,
    headcount: t.Integer({ minimum: 1, maximum: 20 }),
    startTime: isoDateTimeWithTimezoneSchema,
    dueAt: t.Optional(t.Nullable(isoDateTimeWithTimezoneSchema)),
    tagId: t.Optional(t.Nullable(t.String({ format: 'uuid' }))),
    proofRequired: t.Optional(t.Boolean()),
    locations: t.Optional(t.Array(locationSchema, { maxItems: 10 })),
  },
  { additionalProperties: false },
);

export const normalizeQuestV2CreateBody = ({ body }: { body: unknown }) => {
  rejectUnknownFields(questV2CreateSchema)({ body });
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return;

  const payload = body as Record<string, unknown>;
  if (typeof payload.title === 'string') payload.title = payload.title.trim();
  if (typeof payload.description === 'string') payload.description = payload.description.trim();

  if (typeof payload.condition === 'object' && payload.condition !== null) {
    const condition = payload.condition as Record<string, unknown>;
    if (Array.isArray(condition.items)) {
      condition.items = condition.items.map((item) =>
        typeof item === 'string' ? item.trim() : item,
      );
    }
  }

  if (Array.isArray(payload.locations)) {
    payload.locations = payload.locations.map((location) => {
      if (typeof location !== 'object' || location === null || Array.isArray(location)) {
        return location;
      }

      const normalized = { ...(location as Record<string, unknown>) };
      if (typeof normalized.label === 'string') normalized.label = normalized.label.trim();
      return normalized;
    });
  }
};

export const questV2MineQuerySchema = t.Object(
  {
    limit: t.Optional(t.Integer({ minimum: 1, maximum: 50 })),
    cursor: t.Optional(t.String()),
  },
  { additionalProperties: false },
);

export const questV2ParamsSchema = t.Object({
  questId: t.String({ format: 'uuid' }),
});

const questV2TagSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  name: t.String(),
});

const questV2ConditionItemSchema = t.Object({
  position: t.Integer({ minimum: 0 }),
  text: t.String(),
});

export const questV2CanonicalQuestSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  title: t.String(),
  description: t.Nullable(t.String()),
  condition: t.Object({ items: t.Array(questV2ConditionItemSchema, { minItems: 1 }) }),
  tag: t.Nullable(questV2TagSchema),
  mode: questV2ModeSchema,
  participation: questV2ParticipationSchema,
  state: questV2StateSchema,
  questFundingTotal: questFundingTotalSchema,
  headcount: t.Integer({ minimum: 1 }),
  startTime: t.String({ format: 'date-time' }),
  dueAt: t.Nullable(t.String({ format: 'date-time' })),
  proofRequired: t.Boolean(),
  locations: t.Array(t.Object({ label: t.Nullable(t.String()) })),
  createdAt: t.String({ format: 'date-time' }),
  updatedAt: t.String({ format: 'date-time' }),
});

export const questV2CreateResponseSchema = t.Object({
  success: t.Literal(true),
  data: questV2CanonicalQuestSchema,
});

export const questV2MineResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    items: t.Array(questV2CanonicalQuestSchema),
    nextCursor: t.Nullable(t.String()),
  }),
});

export const questV2DetailResponseSchema = questV2CreateResponseSchema;

export const questV2WriteHeadersSchema = t.Object({
  'idempotency-key': t.String({ minLength: 1, maxLength: 200, pattern: '\\S' }),
});

export type QuestV2CreateInput = Static<typeof questV2CreateSchema>;
export type QuestV2MineQuery = Static<typeof questV2MineQuerySchema>;
export type QuestV2Params = Static<typeof questV2ParamsSchema>;
export type QuestV2WriteHeaders = Static<typeof questV2WriteHeadersSchema>;
