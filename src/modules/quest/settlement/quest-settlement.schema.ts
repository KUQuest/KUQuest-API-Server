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

export const questV2CancelHeadersSchema = t.Object({
  'idempotency-key': questSettlementHeadersSchema.properties['idempotency-key'],
  'x-cancel-preview-version': t.Optional(
    t.String({
      minLength: 1,
      maxLength: 200,
      description:
        'Optional previewVersion from GET /cancel-preview. When the Quest changed since the preview, the Server refuses with 409 CANCEL_PREVIEW_STALE and moves no money.',
    })
  ),
});

export const questV2CancelPreviewResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    questStatus: t.String(),
    tier: t.Union([
      t.Literal('NO_PENALTY'),
      t.Literal('PARTIAL_PENALTY'),
      t.Literal('FULL_PENALTY'),
    ]),
    paidSatang: t.Integer({ minimum: 0, description: 'Paid to Workers.' }),
    refundedSatang: t.Integer({ minimum: 0, description: 'Returned to the Hirer wallet.' }),
    platformFeeSatang: t.Integer({
      minimum: 0,
      description: 'Platform Fee the Platform keeps. Zero when the fee is part of the refund.',
    }),
    affectedWorkerCount: t.Integer({ minimum: 0 }),
    computedAt: t.String({ format: 'date-time' }),
    previewVersion: t.String(),
  }),
});
