import { t } from 'elysia';

export const questSettlementParamsSchema = t.Object({ questId: t.String({ format: 'uuid' }) });

export const questSettlementHeadersSchema = t.Object({
  'idempotency-key': t.String({
    minLength: 1,
    maxLength: 200,
    pattern: '\\S',
    description: 'Non-blank command identity for replay-safe Quest settlement',
  }),
});

export const questCancellationResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    questStatus: t.Literal('QUEST_CANCELLED'),
    outcome: t.Literal('CANCELLED'),
    paidSatang: t.Integer({ minimum: 0 }),
    refundedSatang: t.Integer({ minimum: 0 }),
  }),
});

const questCancellationPreviewDataSchema = t.Object({
  questStatus: t.Union([
    t.Literal('QUEST_DRAFT'),
    t.Literal('QUEST_OPEN'),
    t.Literal('QUEST_ASSIGNED'),
    t.Literal('QUEST_IN_PROGRESS'),
  ]),
  tier: t.Union([t.Literal('NO_PENALTY'), t.Literal('PARTIAL_PENALTY'), t.Literal('FULL_PENALTY')]),
  paidSatang: t.Integer({ minimum: 0 }),
  refundedSatang: t.Integer({ minimum: 0 }),
  platformFeeSatang: t.Integer({ minimum: 0 }),
  affectedWorkerCount: t.Integer({ minimum: 0 }),
  computedAt: t.String({ format: 'date-time' }),
  previewVersion: t.String({ minLength: 1 }),
});

export const questCancellationPreviewResponseSchema = t.Object({
  success: t.Literal(true),
  data: questCancellationPreviewDataSchema,
});

export const questCancellationPreviewStaleResponseSchema = t.Object({
  success: t.Literal(false),
  error: t.Object({
    code: t.Literal('CANCEL_PREVIEW_STALE'),
    message: t.String(),
    preview: questCancellationPreviewDataSchema,
  }),
});
