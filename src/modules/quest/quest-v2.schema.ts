import { rejectUnknownFields } from '@/shared/reject-unknown-fields';

import { TypeCompiler } from '@sinclair/typebox/compiler';
import { t, type Static } from 'elysia';
import type { StandardSchemaV1Like } from 'elysia/types';

import { questV2Modes, questV2Participations, questV2States } from './quest-v2.contract';

export const maxQuestV2Images = 3;

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
    label: t.String({ minLength: 1, maxLength: 100, pattern: '\\S' }),
  },
  { additionalProperties: false },
);
const conditionSchema = t.Object(
  { items: conditionItemsSchema },
  { additionalProperties: false },
);
const locationsSchema = t.Array(locationSchema, { maxItems: 10 });
const questFundingTotalSchema = t.Number({
  minimum: 1,
  maximum: 700000,
  description:
    'Inclusive Quest Funding Total in Baht with exact satang precision (at most two decimal places).',
});
const questFundingTotalOpenApiSchema = t.Number({
  minimum: 1,
  maximum: 700000,
  multipleOf: 0.01,
  description:
    'Inclusive Quest Funding Total in Baht with exact satang precision (at most two decimal places).',
});

const questV2CreateProperties = {
  title: titleSchema,
  description: t.Optional(descriptionSchema),
  condition: conditionSchema,
  mode: questV2ModeSchema,
  participation: questV2ParticipationSchema,
  questFundingTotal: questFundingTotalSchema,
  headcount: t.Integer({ minimum: 1, maximum: 20 }),
  startTime: isoDateTimeWithTimezoneSchema,
  dueAt: t.Optional(t.Nullable(isoDateTimeWithTimezoneSchema)),
  tagId: t.Optional(t.Nullable(t.String({ format: 'uuid' }))),
  proofRequired: t.Optional(t.Boolean()),
  locations: t.Optional(locationsSchema),
};

export const questV2CreateSchema = t.Object(
  questV2CreateProperties,
  { additionalProperties: false },
);

export type QuestV2CreateInput = Static<typeof questV2CreateSchema>;

const questV2EditProperties = {
  title: t.Optional(titleSchema),
  description: t.Optional(descriptionSchema),
  condition: t.Optional(conditionSchema),
  mode: t.Optional(questV2ModeSchema),
  participation: t.Optional(questV2ParticipationSchema),
  questFundingTotal: t.Optional(questFundingTotalSchema),
  headcount: t.Optional(t.Integer({ minimum: 1, maximum: 20 })),
  startTime: t.Optional(isoDateTimeWithTimezoneSchema),
  dueAt: t.Optional(t.Nullable(isoDateTimeWithTimezoneSchema)),
  tagId: t.Optional(t.Nullable(t.String({ format: 'uuid' }))),
  proofRequired: t.Optional(t.Boolean()),
  locations: t.Optional(locationsSchema),
};

export const questV2EditSchema = t.Object(questV2EditProperties, {
  additionalProperties: false,
  minProperties: 1,
});

export type QuestV2EditInput = Static<typeof questV2EditSchema>;

const questV2CreateOpenApiSchema = t.Object(
  { ...questV2CreateProperties, questFundingTotal: questFundingTotalOpenApiSchema },
  { additionalProperties: false },
);
const questV2EditOpenApiSchema = t.Object(
  {
    ...questV2EditProperties,
    questFundingTotal: t.Optional(questFundingTotalOpenApiSchema),
  },
  { additionalProperties: false, minProperties: 1 },
);

// TypeBox applies multipleOf with JavaScript remainder, which can reject valid
// decimal Baht values. Keep the OpenAPI constraint and validate the exact
// decimal representation at runtime.
const questV2CreateValidator = TypeCompiler.Compile(questV2CreateSchema);
const hasExactSatangPrecision = (value: unknown): value is number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  const fractionalPart = value.toString().split('.')[1];
  return fractionalPart === undefined || /^\d{1,2}$/.test(fractionalPart);
};

type QuestV2CreateHttpSchema = StandardSchemaV1Like<
  QuestV2CreateInput,
  QuestV2CreateInput
> & {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: 'elysia';
    readonly validate: (value: unknown) =>
      | { value: QuestV2CreateInput; issues?: never }
      | { value?: never; issues: unknown[] };
    readonly jsonSchema: {
      readonly input: () => typeof questV2CreateOpenApiSchema;
    };
  };
};

export const questV2CreateHttpSchema = {
  '~standard': {
    version: 1 as const,
    vendor: 'elysia' as const,
    types: undefined as unknown as {
      input: QuestV2CreateInput;
      output: QuestV2CreateInput;
    },
    validate: (value: unknown) => {
      if (!questV2CreateValidator.Check(value)) {
        return { issues: [...questV2CreateValidator.Errors(value)] };
      }

      if (!hasExactSatangPrecision(value.questFundingTotal)) {
        return {
          issues: [
            {
              path: ['questFundingTotal'],
              message: 'Expected number to use at most two decimal places',
            },
          ],
        };
      }

      return { value };
    },
    jsonSchema: {
      input: () => questV2CreateOpenApiSchema,
    },
  },
} as QuestV2CreateHttpSchema;

type QuestV2EditHttpSchema = StandardSchemaV1Like<QuestV2EditInput, QuestV2EditInput> & {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: 'elysia';
    readonly validate: (value: unknown) =>
      | { value: QuestV2EditInput; issues?: never }
      | { value?: never; issues: unknown[] };
    readonly jsonSchema: {
      readonly input: () => typeof questV2EditOpenApiSchema;
    };
  };
};

const questV2EditValidator = TypeCompiler.Compile(questV2EditSchema);

export const questV2EditHttpSchema = {
  '~standard': {
    version: 1 as const,
    vendor: 'elysia' as const,
    types: undefined as unknown as {
      input: QuestV2EditInput;
      output: QuestV2EditInput;
    },
    validate: (value: unknown) => {
      if (!questV2EditValidator.Check(value)) {
        return { issues: [...questV2EditValidator.Errors(value)] };
      }

      if (
        'questFundingTotal' in value &&
        !hasExactSatangPrecision(value.questFundingTotal)
      ) {
        return {
          issues: [
            {
              path: ['questFundingTotal'],
              message: 'Expected number to use at most two decimal places',
            },
          ],
        };
      }

      return { value };
    },
    jsonSchema: {
      input: () => questV2EditOpenApiSchema,
    },
  },
} as QuestV2EditHttpSchema;

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

export const normalizeQuestV2EditBody = ({ body }: { body: unknown }) => {
  rejectUnknownFields(questV2EditSchema)({ body });
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

export const questV2ImageParamsSchema = t.Object({
  questId: t.String({ format: 'uuid' }),
  imageId: t.String({ format: 'uuid' }),
});

export const questV2ImagesUploadSchema = t.Object(
  {
    images: t.Files({ minItems: 1, maxItems: maxQuestV2Images }),
  },
  { additionalProperties: false },
);

const questV2TagSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  name: t.String(),
});

const questV2ConditionItemSchema = t.Object({
  position: t.Integer({ minimum: 0 }),
  text: t.String(),
});

export const questV2ImageSchema = t.Object({
  imageId: t.String({ format: 'uuid' }),
  fileId: t.String({ format: 'uuid' }),
  position: t.Integer({ minimum: 0 }),
  url: t.String({ format: 'uri' }),
  urlExpiresAt: t.String({ format: 'date-time' }),
});

export const questV2CanonicalQuestSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  version: t.Integer({ minimum: 1 }),
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
  locations: t.Array(t.Object({ label: t.String({ minLength: 1, maxLength: 100, pattern: '\\S' }) })),
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

export const questV2DetailSchema = t.Composite([
  questV2CanonicalQuestSchema,
  t.Object({ images: t.Array(questV2ImageSchema) }),
]);

export const questV2DetailResponseSchema = t.Object({
  success: t.Literal(true),
  data: questV2DetailSchema,
});

export const questV2EditResponseSchema = questV2CreateResponseSchema;

export const questV2ImagesResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    images: t.Array(questV2ImageSchema),
  }),
});

const questV2PublishReasonSchema = t.Object({
  code: t.String(),
  message: t.String(),
});

const questV2FundingQuoteAmountSchema = t.Number({ minimum: 0 });
const questV2FundingQuoteAmountOpenApiSchema = t.Number({
  minimum: 0,
  multipleOf: 0.01,
  description:
    'Baht amount with exact satang precision (at most two decimal places).',
});

const questV2PublishCheckResponseProperties = {
  blockingReasons: t.Array(questV2PublishReasonSchema),
  warnings: t.Array(questV2PublishReasonSchema),
  canPublish: t.Boolean(),
  questFundingTotal: questFundingTotalSchema,
  questFundingTotalSatang: t.Integer({ minimum: 100, maximum: 70_000_000 }),
  questReward: questV2FundingQuoteAmountSchema,
  questRewardSatang: t.Integer({ minimum: 0 }),
  platformFee: questV2FundingQuoteAmountSchema,
  platformFeeSatang: t.Integer({ minimum: 0 }),
  escrowRequirement: questV2FundingQuoteAmountSchema,
  escrowRequirementSatang: t.Integer({ minimum: 0, maximum: 2_000_000_000 }),
  headcount: t.Integer({ minimum: 1, maximum: 20 }),
  platformFeeBps: t.Integer({ minimum: 0, maximum: 10000 }),
  feeRoundingMode: t.Literal('UP'),
  policyRevisionId: t.String({ format: 'uuid' }),
  policyRevision: t.Integer({ minimum: 1 }),
};

const questV2PublishCheckDataOpenApiSchema = t.Object({
  ...questV2PublishCheckResponseProperties,
  questFundingTotal: questFundingTotalOpenApiSchema,
  questReward: questV2FundingQuoteAmountOpenApiSchema,
  platformFee: questV2FundingQuoteAmountOpenApiSchema,
  escrowRequirement: questV2FundingQuoteAmountOpenApiSchema,
});

const questV2PublishCheckResponseOpenApiSchema = t.Object({
  success: t.Literal(true),
  data: questV2PublishCheckDataOpenApiSchema,
});

export const questV2PublishCheckResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object(questV2PublishCheckResponseProperties),
});

const questV2PublishCheckResponseValidator = TypeCompiler.Compile(
  questV2PublishCheckResponseSchema,
);

type QuestV2PublishCheckHttpResponseSchema = StandardSchemaV1Like<
  Static<typeof questV2PublishCheckResponseSchema>,
  Static<typeof questV2PublishCheckResponseSchema>
> & {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: 'elysia';
    readonly validate: (value: unknown) =>
      | { value: Static<typeof questV2PublishCheckResponseSchema>; issues?: never }
      | { value?: never; issues: unknown[] };
    readonly jsonSchema: {
      readonly input: () => typeof questV2PublishCheckResponseOpenApiSchema;
      readonly output: () => typeof questV2PublishCheckResponseOpenApiSchema;
    };
  };
};

export const questV2PublishCheckHttpResponseSchema = {
  '~standard': {
    version: 1 as const,
    vendor: 'elysia' as const,
    types: undefined as unknown as {
      input: Static<typeof questV2PublishCheckResponseSchema>;
      output: Static<typeof questV2PublishCheckResponseSchema>;
    },
    validate: (value: unknown) => {
      if (!questV2PublishCheckResponseValidator.Check(value)) {
        return {
          issues: [...questV2PublishCheckResponseValidator.Errors(value)],
        };
      }

      return {
        value: value as Static<typeof questV2PublishCheckResponseSchema>,
      };
    },
    jsonSchema: {
      input: () => questV2PublishCheckResponseOpenApiSchema,
      output: () => questV2PublishCheckResponseOpenApiSchema,
    },
  },
} as QuestV2PublishCheckHttpResponseSchema;

export const questV2WriteHeadersSchema = t.Object({
  'idempotency-key': t.String({ minLength: 1, maxLength: 200, pattern: '\\S' }),
});

export const questV2EditHeadersSchema = t.Object(
  {
    'idempotency-key': t.String({ minLength: 1, maxLength: 200, pattern: '\\S' }),
    'if-match': t.String({ minLength: 1, pattern: '\\S' }),
  },
  { additionalProperties: false },
);

export type QuestV2MineQuery = Static<typeof questV2MineQuerySchema>;
export type QuestV2Params = Static<typeof questV2ParamsSchema>;
export type QuestV2ImageParams = Static<typeof questV2ImageParamsSchema>;
export type QuestV2ImagesUploadInput = Static<typeof questV2ImagesUploadSchema>;
export type QuestV2WriteHeaders = Static<typeof questV2WriteHeadersSchema>;
export type QuestV2EditHeaders = Static<typeof questV2EditHeadersSchema>;
