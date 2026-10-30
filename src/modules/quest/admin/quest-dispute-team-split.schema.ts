import { questV2DisputeTeamSplitSchema } from '@/modules/quest/v2/core/quest-v2.schema';

import { t } from 'elysia';

export const questDisputeTeamSplitParamsSchema = t.Object({
  questId: t.String({ format: 'uuid' }),
});

export const questDisputeTeamSplitHeadersSchema = t.Object({
  'idempotency-key': t.String({ minLength: 1, maxLength: 200, pattern: '\\S' }),
});

export const questDisputeTeamSplitBodySchema = t.Object(
  {
    shares: t.Array(
      t.Object(
        {
          memberId: t.String({ format: 'uuid' }),
          percentageBasisPoints: t.Integer({ minimum: 0, maximum: 10000 }),
        },
        { additionalProperties: false }
      ),
      { minItems: 2, maxItems: 20 }
    ),
  },
  { additionalProperties: false }
);

export const questDisputeTeamSplitResponseSchema = t.Object({
  success: t.Literal(true),
  data: questV2DisputeTeamSplitSchema,
});

export type QuestDisputeTeamSplitBody = typeof questDisputeTeamSplitBodySchema.static;
