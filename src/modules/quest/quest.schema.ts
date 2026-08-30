import { t } from 'elysia';

import {
  questMode,
  questParticipation,
  questStatuses,
} from './quest.contract';

export const maxQuestImages = 3;

const questModeSchema = t.Union([
  t.Literal(questMode.noCandidate),
  t.Literal(questMode.candidate),
]);

const questParticipationSchema = t.Union([
  t.Literal(questParticipation.solo),
  t.Literal(questParticipation.group),
]);
const questStatusSchema = t.Union([
  t.Literal(questStatuses[0]),
  t.Literal(questStatuses[1]),
  t.Literal(questStatuses[2]),
  t.Literal(questStatuses[3]),
  t.Literal(questStatuses[4]),
  t.Literal(questStatuses[5]),
  t.Literal(questStatuses[6]),
  t.Literal(questStatuses[7]),
  t.Literal(questStatuses[8]),
  t.Literal(questStatuses[9]),
  t.Literal(questStatuses[10]),
  t.Literal(questStatuses[11]),
]);

const locationInputSchema = t.Object(
  {
    label: t.Optional(t.Nullable(t.String({ maxLength: 100, pattern: '\\S' }))),
  },
  { additionalProperties: false },
);

const titleSchema = t.String({ minLength: 1, maxLength: 120, pattern: '\\S' });
const descriptionSchema = t.Nullable(t.String({ maxLength: 1000, pattern: '\\S' }));
const conditionSchema = t.String({ minLength: 1, maxLength: 1000, pattern: '\\S' });
const startTimeSchema = t.String({ format: 'date-time' });
const dueAtSchema = t.Nullable(t.String({ format: 'date-time' }));
const tagIdSchema = t.Nullable(t.String({ format: 'uuid' }));
const locationsSchema = t.Array(locationInputSchema, { maxItems: 10 });

export const questCreateSchema = t.Object(
  {
    title: titleSchema,
    description: t.Optional(descriptionSchema),
    condition: conditionSchema,
    mode: questModeSchema,
    participation: questParticipationSchema,
    reward: t.Integer({ minimum: 1, maximum: 700000 }),
    headcount: t.Integer({ minimum: 1, maximum: 20 }),
    startTime: startTimeSchema,
    dueAt: t.Optional(dueAtSchema),
    tagId: t.Optional(tagIdSchema),
    proofRequired: t.Optional(t.Boolean()),
    locations: t.Optional(locationsSchema),
  },
  { additionalProperties: false },
);

const questImageIdsSchema = t.Array(t.String({ format: 'uuid' }), {
  maxItems: maxQuestImages,
});

export const questDirectEditSchema = t.Object(
  {
    title: t.Optional(titleSchema),
    description: t.Optional(descriptionSchema),
    condition: t.Optional(conditionSchema),
    startTime: t.Optional(startTimeSchema),
    dueAt: t.Optional(dueAtSchema),
    proofRequired: t.Optional(t.Boolean()),
    tagId: t.Optional(tagIdSchema),
    locations: t.Optional(locationsSchema),
  },
  { additionalProperties: false },
);

export const questEditSchema = t.Object(
  {
    title: t.Optional(titleSchema),
    description: t.Optional(descriptionSchema),
    condition: t.Optional(conditionSchema),
    startTime: t.Optional(startTimeSchema),
    dueAt: t.Optional(dueAtSchema),
    proofRequired: t.Optional(t.Boolean()),
    locations: t.Optional(locationsSchema),
    images: t.Optional(questImageIdsSchema),
    mode: t.Optional(questModeSchema),
    participation: t.Optional(questParticipationSchema),
    reward: t.Optional(t.Integer({ minimum: 1, maximum: 700000 })),
    headcount: t.Optional(t.Integer({ minimum: 1, maximum: 20 })),
    tagId: t.Optional(tagIdSchema),
  },
  { additionalProperties: false },
);

export const questParamsSchema = t.Object({
  questId: t.String({ format: 'uuid' }),
});

export const questImageParamsSchema = t.Object({
  questId: t.String({ format: 'uuid' }),
  imageId: t.String({ format: 'uuid' }),
});

export const questEditRequestParamsSchema = t.Object({
  requestId: t.String({ format: 'uuid' }),
});

export const questImagesUploadSchema = t.Object(
  {
    images: t.Files({ minItems: 1, maxItems: maxQuestImages }),
  },
  { additionalProperties: false },
);

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
    limit: t.Optional(t.Integer({ minimum: 1, maximum: 50 })),
    cursor: t.Optional(t.String()),
  },
  { additionalProperties: false },
);

export const questMineQuerySchema = t.Object(
  {
    limit: t.Optional(t.Integer({ minimum: 1, maximum: 50 })),
    cursor: t.Optional(t.String()),
  },
  { additionalProperties: false },
);

const tagSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  name: t.String(),
});

const locationSchema = t.Object({
  label: t.Nullable(t.String()),
});

export const questImageSchema = t.Object({
  fileId: t.String({ format: 'uuid' }),
  position: t.Integer({ minimum: 0 }),
  url: t.String({ format: 'uri' }),
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
});

export const questCardSchema = t.Composite([
  questSummarySchema,
  t.Object({ tag: tagSchema }),
]);

export const questListItemSchema = t.Composite([
  questSummarySchema,
  t.Object({ questStatus: questStatusSchema }),
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
  questStatus: questStatusSchema,
  headcount: t.Integer({ minimum: 1 }),
  startTime: t.String({ format: 'date-time' }),
  dueAt: t.Nullable(t.String({ format: 'date-time' })),
  estimatedDurationMinutes: t.Nullable(t.Integer({ minimum: 1 })),
  proofRequired: t.Boolean(),
  hirerName: t.String(),
  locations: t.Array(locationSchema),
  images: t.Array(questImageSchema),
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

export const questEditRequestSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  questId: t.String({ format: 'uuid' }),
  requestedByUserId: t.String({ format: 'uuid' }),
  status: t.String(),
  previousQuestStatus: questStatusSchema,
  createdAt: t.String({ format: 'date-time' }),
  expiresAt: t.String({ format: 'date-time' }),
  proposedChanges: t.Record(t.String(), t.Unknown()),
  responses: t.Array(
    t.Object({
      userId: t.String({ format: 'uuid' }),
      decision: t.Nullable(t.String()),
      respondedAt: t.Nullable(t.String({ format: 'date-time' })),
    }),
  ),
});

export const questEditRequestResponseSchema = t.Object({
  success: t.Literal(true),
  data: questEditRequestSchema,
});

export const questEditRequestCreateResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    status: t.String(),
    requestId: t.String({ format: 'uuid' }),
    expiresAt: t.String({ format: 'date-time' }),
  }),
});

export const questEditResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    status: t.String(),
    requestId: t.String({ format: 'uuid' }),
  }),
});

export const questEditDecisionSchema = t.Object(
  { decision: t.Union([t.Literal('EDIT_RESPONSE_APPROVED'), t.Literal('EDIT_RESPONSE_REJECTED')]) },
  { additionalProperties: false },
);

export const questImagesUploadResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    images: t.Array(questImageSchema),
  }),
});

const questPublishReasonSchema = t.Object({
  code: t.String(),
  message: t.String(),
});

export const questPublishCheckResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    blockingReasons: t.Array(questPublishReasonSchema),
    warnings: t.Array(questPublishReasonSchema),
    escrowRequirement: t.Integer({ minimum: 0 }),
    escrowRequirementSatang: t.Integer({ minimum: 0 }),
    platformFeeBps: t.Integer({ minimum: 0, maximum: 10000 }),
    platformFeePerWorkerSatang: t.Integer({ minimum: 0 }),
    policyRevisionId: t.Optional(t.String({ format: 'uuid' })),
    policyRevision: t.Optional(t.Integer({ minimum: 1 })),
    canPublish: t.Boolean(),
  }),
});

export const questPublishResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    outcome: t.Literal('published'),
    reservationId: t.String({ format: 'uuid' }),
    policyRevisionId: t.String({ format: 'uuid' }),
    policyRevision: t.Integer({ minimum: 1 }),
    platformFeeBps: t.Integer({ minimum: 0, maximum: 10000 }),
    platformFeePerWorkerSatang: t.Integer({ minimum: 0 }),
    questEscrowSatang: t.Integer({ minimum: 1 }),
  }),
});

export type QuestCreateInput = typeof questCreateSchema.static;
export type QuestDirectEditInput = typeof questDirectEditSchema.static;
export type QuestEditInput = typeof questEditSchema.static;
export type QuestImagesUploadInput = typeof questImagesUploadSchema.static;
export type QuestListQuery = typeof questListQuerySchema.static;
export type QuestMineQuery = typeof questMineQuerySchema.static;
