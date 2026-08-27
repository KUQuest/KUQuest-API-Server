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

const allocationSchema = t.Object({
  workerId: t.String({ format: 'uuid' }),
  amountSatang: t.Integer({ minimum: 1 }),
}, { additionalProperties: false });

export const questDisputeResolutionSchema = t.Object({
  outcome: t.Union([t.Literal('REFUND_HIRER'), t.Literal('RELEASE_TO_WORKER')]),
  allocations: t.Optional(t.Array(allocationSchema, { maxItems: 20 })),
}, { additionalProperties: false });

export const questDisputeResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    questStatus: t.Union([t.Literal('QUEST_CANCELLED'), t.Literal('QUEST_COMPLETED')]),
    outcome: t.Union([t.Literal('REFUNDED'), t.Literal('RELEASED_TO_WORKER')]),
    paidSatang: t.Integer({ minimum: 0 }),
    refundedSatang: t.Integer({ minimum: 0 }),
  }),
});

export type QuestDisputeResolutionInput = typeof questDisputeResolutionSchema.static;
