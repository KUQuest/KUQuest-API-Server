import { t } from 'elysia';

export const questV2RewardAllocationParamsSchema = t.Object({
  questId: t.String({ format: 'uuid' }),
});

export const questV2RewardAllocationHeadersSchema = t.Object({
  'idempotency-key': t.String({ minLength: 1, maxLength: 200, pattern: '\\S' }),
});

export const questV2RewardAllocationRequestSchema = t.Object(
  {
    teammateShares: t.Array(
      t.Object(
        {
          memberId: t.String({ format: 'uuid' }),
          percentageBasisPoints: t.Integer({ minimum: 0, maximum: 10000 }),
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 19 }
    ),
  },
  { additionalProperties: false }
);

export const questV2RewardAllocationResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    status: t.Union([t.Literal('PENDING'), t.Literal('SUBMITTED'), t.Literal('AUTO_EQUAL')]),
    leaderId: t.String({ format: 'uuid' }),
    totalRewardSatang: t.Integer({ minimum: 1 }),
    deadlineAt: t.String({ format: 'date-time' }),
    settledAt: t.Nullable(t.String({ format: 'date-time' })),
    viewerIsLeader: t.Boolean(),
    members: t.Array(
      t.Object({
        memberId: t.String({ format: 'uuid' }),
        displayName: t.String(),
        isLeader: t.Boolean(),
        percentageBasisPoints: t.Nullable(t.Integer({ minimum: 0, maximum: 10000 })),
        rewardSatang: t.Nullable(t.Integer({ minimum: 0 })),
      })
    ),
  }),
});

export type QuestV2RewardAllocationRequest = typeof questV2RewardAllocationRequestSchema.static;
