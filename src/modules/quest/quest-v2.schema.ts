import { rejectUnknownFields } from '@/shared/reject-unknown-fields';

import type { TSchema } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { t, type Static } from 'elysia';
import type { StandardSchemaV1Like } from 'elysia/types';

import {
  questV2CanonicalScheduleTimePattern,
  isQuestV2ScheduleTime,
  questV2Modes,
  questV2Participations,
  questV2ScheduleTimePattern,
  questV2EditFailureCodes,
  questV2EditRequestStatuses,
  questV2EditResponseDecisions,
  questV2States,
} from './quest-v2.contract';

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
const isoDateTimeWithBangkokTimezoneOpenApiSchema = t.String({
  format: 'date-time',
  pattern: questV2ScheduleTimePattern.source,
  description: 'RFC 3339 date-time with the fixed Asia/Bangkok +07:00 offset.',
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
// The lower bound depends on participation. The service validates the complete
// combination because PATCH may omit either participation or headcount.
const questV2HeadcountSchema = t.Integer({
  minimum: 1,
  maximum: 20,
  description: 'SINGLE requires exactly 1 Worker; GROUP requires 2 to 20 Workers.',
});
const questV2SingleHeadcountOpenApiSchema = t.Integer({
  minimum: 1,
  maximum: 1,
  description: 'SINGLE requires exactly 1 Worker.',
});
const questV2GroupHeadcountOpenApiSchema = t.Integer({
  minimum: 2,
  maximum: 20,
  description: 'GROUP requires 2 to 20 Workers.',
});

const questV2CreateProperties = {
  title: titleSchema,
  description: t.Optional(descriptionSchema),
  condition: conditionSchema,
  mode: questV2ModeSchema,
  participation: questV2ParticipationSchema,
  questFundingTotal: questFundingTotalSchema,
  headcount: questV2HeadcountSchema,
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

const questV2EditCommonProperties = {
  title: t.Optional(titleSchema),
  description: t.Optional(descriptionSchema),
  condition: t.Optional(conditionSchema),
  mode: t.Optional(questV2ModeSchema),
  questFundingTotal: t.Optional(questFundingTotalSchema),
  startTime: t.Optional(isoDateTimeWithTimezoneSchema),
  dueAt: t.Optional(t.Nullable(isoDateTimeWithTimezoneSchema)),
  tagId: t.Optional(t.Nullable(t.String({ format: 'uuid' }))),
  proofRequired: t.Optional(t.Boolean()),
  locations: t.Optional(locationsSchema),
};

const questV2EditProperties = {
  ...questV2EditCommonProperties,
  participation: t.Optional(questV2ParticipationSchema),
  headcount: t.Optional(questV2HeadcountSchema),
};

export const questV2EditSchema = t.Object(questV2EditProperties, {
  additionalProperties: false,
  minProperties: 1,
});

export type QuestV2EditInput = Static<typeof questV2EditSchema>;

const questV2CreateOpenApiProperties = {
  ...questV2CreateProperties,
  questFundingTotal: questFundingTotalOpenApiSchema,
  startTime: isoDateTimeWithBangkokTimezoneOpenApiSchema,
  dueAt: t.Optional(t.Nullable(isoDateTimeWithBangkokTimezoneOpenApiSchema)),
};
const questV2CreateOpenApiSchema = t.Union([
  t.Object(
    {
      ...questV2CreateOpenApiProperties,
      participation: t.Literal('SINGLE'),
      headcount: questV2SingleHeadcountOpenApiSchema,
    },
    { additionalProperties: false },
  ),
  t.Object(
    {
      ...questV2CreateOpenApiProperties,
      participation: t.Literal('GROUP'),
      headcount: questV2GroupHeadcountOpenApiSchema,
    },
    { additionalProperties: false },
  ),
]);
const questV2EditOpenApiCommonProperties = {
  ...questV2EditCommonProperties,
  questFundingTotal: t.Optional(questFundingTotalOpenApiSchema),
  startTime: t.Optional(isoDateTimeWithBangkokTimezoneOpenApiSchema),
  dueAt: t.Optional(t.Nullable(isoDateTimeWithBangkokTimezoneOpenApiSchema)),
};
const questV2EditOpenApiSchema = t.Union([
  t.Object(
    {
      ...questV2EditOpenApiCommonProperties,
      participation: t.Literal('SINGLE'),
      headcount: t.Optional(questV2SingleHeadcountOpenApiSchema),
    },
    { additionalProperties: false, minProperties: 1 },
  ),
  t.Object(
    {
      ...questV2EditOpenApiCommonProperties,
      participation: t.Literal('GROUP'),
      headcount: t.Optional(questV2GroupHeadcountOpenApiSchema),
    },
    { additionalProperties: false, minProperties: 1 },
  ),
  t.Object(
    {
      ...questV2EditOpenApiCommonProperties,
      headcount: t.Optional(questV2HeadcountSchema),
    },
    { additionalProperties: false, minProperties: 1 },
  ),
]);

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

export const normalizeQuestV2EditRequestCreateBody = ({ body }: { body: unknown }) => {
  rejectUnknownFields(questV2EditRequestCreateSchema)({ body });
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return;

  const payload = body as Record<string, unknown>;
  if (typeof payload.condition !== 'object' || payload.condition === null) return;
  const condition = payload.condition as Record<string, unknown>;
  if (Array.isArray(condition.items)) {
    condition.items = condition.items.map((item) =>
      typeof item === 'string' ? item.trim() : item,
    );
  }
};

export const normalizeQuestV2EditRequestResponseBody = ({ body }: { body: unknown }) => {
  rejectUnknownFields(questV2EditRequestResponseInputSchema)({ body });
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return;

  const payload = body as Record<string, unknown>;
  if (typeof payload.reason === 'string') payload.reason = payload.reason.trim();
};

export const questV2MineQuerySchema = t.Object(
  {
    limit: t.Optional(t.Integer({ minimum: 1, maximum: 50 })),
    cursor: t.Optional(t.String()),
  },
  { additionalProperties: false },
);

const questV2BoardQueryProperties = {
  q: t.Optional(t.String()),
  tagId: t.Optional(t.String({ format: 'uuid' })),
  mode: t.Optional(questV2ModeSchema),
  participation: t.Optional(questV2ParticipationSchema),
  minQuestReward: t.Optional(t.Number({ minimum: 0, maximum: 700000 })),
  maxQuestReward: t.Optional(t.Number({ minimum: 0, maximum: 700000 })),
  maxDurationMinutes: t.Optional(t.Integer({ minimum: 1 })),
  startFrom: t.Optional(t.String({
    format: 'date-time',
    pattern: questV2ScheduleTimePattern.source,
  })),
  startTo: t.Optional(t.String({
    format: 'date-time',
    pattern: questV2ScheduleTimePattern.source,
  })),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 50 })),
  cursor: t.Optional(t.String()),
};

export const questV2BoardQuerySchema = t.Object(
  questV2BoardQueryProperties,
  { additionalProperties: false },
);

const questV2BoardQueryOpenApiSchema = t.Object(
  {
    ...questV2BoardQueryProperties,
    minQuestReward: t.Optional(t.Number({
      minimum: 0,
      maximum: 700000,
      multipleOf: 0.01,
      description: 'Minimum inclusive Quest Reward in Baht with at most two decimal places.',
    })),
    maxQuestReward: t.Optional(t.Number({
      minimum: 0,
      maximum: 700000,
      multipleOf: 0.01,
      description: 'Maximum inclusive Quest Reward in Baht with at most two decimal places.',
    })),
  },
  { additionalProperties: false },
);

const questV2BoardQueryValidator = TypeCompiler.Compile(questV2BoardQuerySchema);

type QuestV2BoardQueryHttpSchema = StandardSchemaV1Like<
  Static<typeof questV2BoardQuerySchema>,
  Static<typeof questV2BoardQuerySchema>
> & {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: 'elysia';
    readonly validate: (value: unknown) =>
      | { value: Static<typeof questV2BoardQuerySchema>; issues?: never }
      | { value?: never; issues: unknown[] };
    readonly jsonSchema: {
      readonly input: () => typeof questV2BoardQueryOpenApiSchema;
    };
  };
};

const hasExactBahtPrecision = (value: unknown): value is number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  const fractionalPart = value.toString().split('.')[1];
  return fractionalPart === undefined || /^\d{1,2}$/.test(fractionalPart);
};

const hasAtMostTwoBahtDecimals = (value: unknown): boolean => {
  if (typeof value !== 'string') return hasExactBahtPrecision(value);

  const mantissa = value.split(/[eE]/, 1)[0];
  const fractionalPart = mantissa?.split('.')[1];
  return fractionalPart === undefined || fractionalPart.length <= 2;
};

const numericQuestV2BoardQueryFields = [
  'minQuestReward',
  'maxQuestReward',
  'maxDurationMinutes',
  'limit',
] as const;

const normalizeQuestV2BoardQueryInput = (value: unknown): unknown => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;

  const query = { ...(value as Record<string, unknown>) };
  for (const field of numericQuestV2BoardQueryFields) {
    if (typeof query[field] === 'string' && query[field] !== '') {
      query[field] = Number(query[field]);
    }
  }
  return query;
};

export const questV2BoardQueryHttpSchema = {
  '~standard': {
    version: 1 as const,
    vendor: 'elysia' as const,
    types: undefined as unknown as {
      input: Static<typeof questV2BoardQuerySchema>;
      output: Static<typeof questV2BoardQuerySchema>;
    },
    validate: (value: unknown) => {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const rawQuery = value as Record<string, unknown>;
        for (const [field, amount] of [
          ['minQuestReward', rawQuery.minQuestReward],
          ['maxQuestReward', rawQuery.maxQuestReward],
        ] as const) {
          if (amount !== undefined && !hasAtMostTwoBahtDecimals(amount)) {
            return {
              issues: [{ path: [field], message: 'Expected Baht amount to use at most two decimal places' }],
            };
          }
        }
      }

      const normalizedValue = normalizeQuestV2BoardQueryInput(value);
      if (!questV2BoardQueryValidator.Check(normalizedValue)) {
        return { issues: [...questV2BoardQueryValidator.Errors(normalizedValue)] };
      }

      const query = normalizedValue as Static<typeof questV2BoardQuerySchema>;
      for (const [field, amount] of [
        ['minQuestReward', query.minQuestReward],
        ['maxQuestReward', query.maxQuestReward],
      ] as const) {
        if (amount !== undefined && !hasExactBahtPrecision(amount)) {
          return {
            issues: [{ path: [field], message: 'Expected Baht amount to use at most two decimal places' }],
          };
        }
      }

      for (const [field, schedule] of [
        ['startFrom', query.startFrom],
        ['startTo', query.startTo],
      ] as const) {
        if (schedule !== undefined && !isQuestV2ScheduleTime(schedule)) {
          return {
            issues: [{ path: [field], message: 'Expected a valid +07:00 schedule time' }],
          };
        }
      }

      return { value: query };
    },
    jsonSchema: {
      input: () => questV2BoardQueryOpenApiSchema,
    },
  },
} as QuestV2BoardQueryHttpSchema;

export const normalizeQuestV2BoardQuery = ({ query }: { query: unknown }) => {
  if (typeof query !== 'object' || query === null || Array.isArray(query)) return;

  const payload = query as Record<string, unknown>;
  if (typeof payload.q === 'string') payload.q = payload.q.trim();
};

export const questV2ParamsSchema = t.Object({
  questId: t.String({ format: 'uuid' }),
});

export const questV2ImageParamsSchema = t.Object({
  questId: t.String({ format: 'uuid' }),
  imageId: t.String({ format: 'uuid' }),
});

export const questV2ImagesUploadSchema = t.Object(
  {
    images: t.Files({
      minItems: 1,
      maxItems: maxQuestV2Images,
      description:
        'One to three Quest Image files in request order. Each file must be a decoded JPEG, PNG, or WebP of at most 5 MB.',
    }),
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
  imageId: t.String({ format: 'uuid', description: 'Quest Image identifier.' }),
  fileId: t.String({ format: 'uuid', description: 'Private file reference.' }),
  position: t.Integer({ minimum: 0, description: 'Zero-based gallery position.' }),
  url: t.String({
    format: 'uri',
    description: 'Temporary image link. The API never returns a permanent storage URL.',
  }),
  urlExpiresAt: t.String({
    format: 'date-time',
    description: 'Expiry time for the temporary image link, 15 minutes after materialization.',
  }),
});

export const questV2CanonicalQuestSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  version: t.Integer({ minimum: 1 }),
  hiddenAt: t.Nullable(t.String({ format: 'date-time' })),
  title: t.String(),
  description: t.Nullable(t.String()),
  condition: t.Object({ items: t.Array(questV2ConditionItemSchema, { minItems: 1 }) }),
  tag: t.Nullable(questV2TagSchema),
  mode: questV2ModeSchema,
  participation: questV2ParticipationSchema,
  state: questV2StateSchema,
  questFundingTotal: questFundingTotalSchema,
  headcount: questV2HeadcountSchema,
  startTime: t.String({
    format: 'date-time',
    pattern: questV2CanonicalScheduleTimePattern.source,
  }),
  dueAt: t.Nullable(t.String({
    format: 'date-time',
    pattern: questV2CanonicalScheduleTimePattern.source,
  })),
  proofRequired: t.Boolean(),
  locations: t.Array(t.Object({ label: t.String({ minLength: 1, maxLength: 100, pattern: '\\S' }) })),
  createdAt: t.String({ format: 'date-time' }),
  updatedAt: t.String({ format: 'date-time' }),
});

const questV2CanonicalQuestOpenApiSchema = t.Object({
  ...questV2CanonicalQuestSchema.properties,
  questFundingTotal: questFundingTotalOpenApiSchema,
});

const questV2CreateResponseOpenApiSchema = t.Object({
  success: t.Literal(true),
  data: questV2CanonicalQuestOpenApiSchema,
});

const questV2MineResponseOpenApiSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    items: t.Array(questV2CanonicalQuestOpenApiSchema),
    nextCursor: t.Nullable(t.String()),
  }),
});

const questV2DetailOpenApiSchema = t.Object({
  ...questV2CanonicalQuestOpenApiSchema.properties,
  images: t.Array(questV2ImageSchema),
});

const questV2DetailResponseOpenApiSchema = t.Object({
  success: t.Literal(true),
  data: questV2DetailOpenApiSchema,
});

type QuestV2HttpResponseSchema<
  RuntimeSchema extends TSchema,
  OpenApiSchema extends TSchema,
> = StandardSchemaV1Like<Static<RuntimeSchema>, Static<RuntimeSchema>> & {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: 'elysia';
    readonly validate: (value: unknown) =>
      | { value: Static<RuntimeSchema>; issues?: never }
      | { value?: never; issues: unknown[] };
    readonly jsonSchema: {
      readonly input: () => OpenApiSchema;
      readonly output: () => OpenApiSchema;
    };
  };
};

const createQuestV2HttpResponseSchema = <
  RuntimeSchema extends TSchema,
  OpenApiSchema extends TSchema,
>(runtimeSchema: RuntimeSchema, openApiSchema: OpenApiSchema) => {
  const validator = TypeCompiler.Compile(runtimeSchema);

  return {
    '~standard': {
      version: 1 as const,
      vendor: 'elysia' as const,
      types: undefined as unknown as {
        input: Static<RuntimeSchema>;
        output: Static<RuntimeSchema>;
      },
      validate: (value: unknown) => {
        if (!validator.Check(value)) {
          return { issues: [...validator.Errors(value)] };
        }

        return { value: value as Static<RuntimeSchema> };
      },
      jsonSchema: {
        input: () => openApiSchema,
        output: () => openApiSchema,
      },
    },
  } as QuestV2HttpResponseSchema<RuntimeSchema, OpenApiSchema>;
};

export const questV2CreateResponseSchema = t.Object({
  success: t.Literal(true),
  data: questV2CanonicalQuestSchema,
});

export const questV2CreateHttpResponseSchema = createQuestV2HttpResponseSchema(
  questV2CreateResponseSchema,
  questV2CreateResponseOpenApiSchema,
);

export const questV2MineResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    items: t.Array(questV2CanonicalQuestSchema),
    nextCursor: t.Nullable(t.String()),
  }),
});

export const questV2MineHttpResponseSchema = createQuestV2HttpResponseSchema(
  questV2MineResponseSchema,
  questV2MineResponseOpenApiSchema,
);

const questV2RewardSchema = t.Number({ minimum: 0, maximum: 700000 });
const questV2CanonicalScheduleSchema = t.String({
  format: 'date-time',
  pattern: questV2CanonicalScheduleTimePattern.source,
});

export const questV2BoardCardSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  title: t.String(),
  questReward: questV2RewardSchema,
  tag: questV2TagSchema,
  mode: questV2ModeSchema,
  participation: questV2ParticipationSchema,
  headcount: t.Integer({ minimum: 1, maximum: 20 }),
  activeWorkerCount: t.Integer({ minimum: 0, maximum: 20 }),
  startTime: questV2CanonicalScheduleSchema,
  dueAt: questV2CanonicalScheduleSchema,
  hirerName: t.String(),
  location: t.Nullable(t.String()),
});

export const questV2BoardResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    items: t.Array(questV2BoardCardSchema),
    nextCursor: t.Nullable(t.String()),
  }),
});

export const questV2PublicImageSchema = t.Object({
  imageId: t.String({ format: 'uuid' }),
  position: t.Integer({ minimum: 0 }),
  url: t.String({ format: 'uri' }),
  urlExpiresAt: t.String({ format: 'date-time' }),
});

export const questV2PublicDetailSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  title: t.String(),
  description: t.Nullable(t.String()),
  condition: t.Object({ items: t.Array(questV2ConditionItemSchema, { minItems: 1 }) }),
  tag: questV2TagSchema,
  mode: questV2ModeSchema,
  participation: questV2ParticipationSchema,
  state: questV2StateSchema,
  questReward: questV2RewardSchema,
  headcount: t.Integer({ minimum: 1, maximum: 20 }),
  activeWorkerCount: t.Integer({ minimum: 0, maximum: 20 }),
  startTime: questV2CanonicalScheduleSchema,
  dueAt: questV2CanonicalScheduleSchema,
  proofRequired: t.Boolean(),
  hirerName: t.String(),
  locations: t.Array(t.Object({ label: t.String({ minLength: 1, maxLength: 100, pattern: '\\S' }) })),
  images: t.Array(questV2PublicImageSchema),
});

export const questV2PublicDetailResponseSchema = t.Object({
  success: t.Literal(true),
  data: questV2PublicDetailSchema,
});

const questV2EditRequestStatusSchema = t.Union([
  t.Literal(questV2EditRequestStatuses[0]),
  t.Literal(questV2EditRequestStatuses[1]),
  t.Literal(questV2EditRequestStatuses[2]),
]);
const questV2EditResponseDecisionSchema = t.Union([
  t.Literal(questV2EditResponseDecisions[0]),
  t.Literal(questV2EditResponseDecisions[1]),
]);
const questV2EditFailureCodeSchema = t.Union([
  t.Literal(questV2EditFailureCodes[0]),
  t.Literal(questV2EditFailureCodes[1]),
  t.Literal(questV2EditFailureCodes[2]),
]);
const questV2EditConditionItemSchema = t.Object({
  position: t.Integer({ minimum: 0 }),
  text: t.String({ minLength: 1, maxLength: 255, pattern: '\\S' }),
});
const questV2EditConditionSchema = t.Object({
  items: t.Array(questV2EditConditionItemSchema, { minItems: 1 }),
});
const questV2EditResponseSummarySchema = t.Object({
  totalCount: t.Integer({ minimum: 0 }),
  acceptedCount: t.Integer({ minimum: 0 }),
  declinedCount: t.Integer({ minimum: 0 }),
  pendingCount: t.Integer({ minimum: 0 }),
});
const questV2EditHirerResponseSchema = t.Object({
  workerId: t.String({ format: 'uuid' }),
  decision: t.Nullable(questV2EditResponseDecisionSchema),
  reason: t.Nullable(t.String({ maxLength: 255 })),
  respondedAt: t.Nullable(t.String({ format: 'date-time' })),
});
const questV2EditWorkerResponseSchema = t.Object({
  decision: t.Nullable(questV2EditResponseDecisionSchema),
  reason: t.Nullable(t.String({ maxLength: 255 })),
  respondedAt: t.Nullable(t.String({ format: 'date-time' })),
});

export const questV2EditRequestCreateSchema = t.Object(
  {
    condition: t.Object(
      { items: conditionItemsSchema },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const questV2EditRequestResponseInputSchema = t.Object(
  {
    decision: questV2EditResponseDecisionSchema,
    reason: t.Optional(t.String({ maxLength: 255, pattern: '\\S' })),
  },
  { additionalProperties: false },
);

export const questV2EditRequestParamsSchema = t.Object({
  requestId: t.String({ format: 'uuid' }),
});

export const questV2EditRequestDataSchema = t.Object({
  requestId: t.String({ format: 'uuid' }),
  questId: t.String({ format: 'uuid' }),
  status: questV2EditRequestStatusSchema,
  failureCode: t.Nullable(questV2EditFailureCodeSchema),
  createdAt: t.String({ format: 'date-time' }),
  expiresAt: t.String({ format: 'date-time' }),
  appliedAt: t.Nullable(t.String({ format: 'date-time' })),
  failedAt: t.Nullable(t.String({ format: 'date-time' })),
  previousCondition: questV2EditConditionSchema,
  proposedCondition: questV2EditConditionSchema,
  responseSummary: questV2EditResponseSummarySchema,
  responses: t.Optional(t.Array(questV2EditHirerResponseSchema)),
  ownResponse: t.Optional(t.Nullable(questV2EditWorkerResponseSchema)),
});

export const questV2EditRequestResponseSchema = t.Object({
  success: t.Literal(true),
  data: questV2EditRequestDataSchema,
});

export type QuestV2EditRequestCreateInput = Static<typeof questV2EditRequestCreateSchema>;
export type QuestV2EditRequestResponseInput = Static<typeof questV2EditRequestResponseInputSchema>;
export type QuestV2EditRequestParams = Static<typeof questV2EditRequestParamsSchema>;
export type QuestV2EditRequestData = Static<typeof questV2EditRequestDataSchema>;

export const questV2DetailSchema = t.Composite([
  questV2CanonicalQuestSchema,
  t.Object({ images: t.Array(questV2ImageSchema) }),
]);

export const questV2DetailResponseSchema = t.Object({
  success: t.Literal(true),
  data: questV2DetailSchema,
});

export const questV2DetailHttpResponseSchema = createQuestV2HttpResponseSchema(
  questV2DetailResponseSchema,
  questV2DetailResponseOpenApiSchema,
);

export const questV2EditResponseSchema = questV2CreateResponseSchema;
export const questV2EditHttpResponseSchema = questV2CreateHttpResponseSchema;

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
  headcount: questV2HeadcountSchema,
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

const questV2QuestEscrowResponseProperties = {
  reservationId: t.String({ format: 'uuid' }),
  questFundingTotal: questV2FundingQuoteAmountSchema,
  questFundingTotalSatang: t.Integer({ minimum: 100, maximum: 70_000_000 }),
  questReward: questV2FundingQuoteAmountSchema,
  questRewardSatang: t.Integer({ minimum: 0 }),
  platformFee: questV2FundingQuoteAmountSchema,
  platformFeeSatang: t.Integer({ minimum: 0 }),
  escrowRequirement: questV2FundingQuoteAmountSchema,
  escrowRequirementSatang: t.Integer({ minimum: 1, maximum: 2_000_000_000 }),
  headcount: questV2HeadcountSchema,
  platformFeeBps: t.Integer({ minimum: 0, maximum: 10000 }),
  feeRoundingMode: t.Literal('UP'),
  policyRevisionId: t.String({ format: 'uuid' }),
  policyRevision: t.Integer({ minimum: 1 }),
};

const questV2QuestEscrowResponseOpenApiSchema = t.Object({
  ...questV2QuestEscrowResponseProperties,
  questFundingTotal: questV2FundingQuoteAmountOpenApiSchema,
  questReward: questV2FundingQuoteAmountOpenApiSchema,
  platformFee: questV2FundingQuoteAmountOpenApiSchema,
  escrowRequirement: questV2FundingQuoteAmountOpenApiSchema,
});

const questV2PublishResponseOpenApiSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    quest: questV2CanonicalQuestOpenApiSchema,
    questEscrow: questV2QuestEscrowResponseOpenApiSchema,
  }),
});

export const questV2PublishResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    quest: questV2CanonicalQuestSchema,
    questEscrow: t.Object(questV2QuestEscrowResponseProperties),
  }),
});

const questV2PublishResponseValidator = TypeCompiler.Compile(questV2PublishResponseSchema);

type QuestV2PublishHttpResponseSchema = StandardSchemaV1Like<
  Static<typeof questV2PublishResponseSchema>,
  Static<typeof questV2PublishResponseSchema>
> & {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: 'elysia';
    readonly validate: (value: unknown) =>
      | { value: Static<typeof questV2PublishResponseSchema>; issues?: never }
      | { value?: never; issues: unknown[] };
    readonly jsonSchema: {
      readonly input: () => typeof questV2PublishResponseOpenApiSchema;
      readonly output: () => typeof questV2PublishResponseOpenApiSchema;
    };
  };
};

export const questV2PublishHttpResponseSchema = {
  '~standard': {
    version: 1 as const,
    vendor: 'elysia' as const,
    types: undefined as unknown as {
      input: Static<typeof questV2PublishResponseSchema>;
      output: Static<typeof questV2PublishResponseSchema>;
    },
    validate: (value: unknown) => {
      if (!questV2PublishResponseValidator.Check(value)) {
        return {
          issues: [...questV2PublishResponseValidator.Errors(value)],
        };
      }

      return {
        value: value as Static<typeof questV2PublishResponseSchema>,
      };
    },
    jsonSchema: {
      input: () => questV2PublishResponseOpenApiSchema,
      output: () => questV2PublishResponseOpenApiSchema,
    },
  },
} as QuestV2PublishHttpResponseSchema;

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
export type QuestV2BoardQuery = Static<typeof questV2BoardQuerySchema>;
export type QuestV2Params = Static<typeof questV2ParamsSchema>;
export type QuestV2ImageParams = Static<typeof questV2ImageParamsSchema>;
export type QuestV2ImagesUploadInput = Static<typeof questV2ImagesUploadSchema>;
export type QuestV2WriteHeaders = Static<typeof questV2WriteHeadersSchema>;
export type QuestV2EditHeaders = Static<typeof questV2EditHeadersSchema>;
