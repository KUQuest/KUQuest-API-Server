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
