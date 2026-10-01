import { t, type Static } from 'elysia';

import { memberSummarySchema } from '../../shared/member-summary';
import { questV2AssignmentStates, questV2States } from '../core/quest-v2.contract';
import { questV2UnderfilledSummarySchema } from '../lifecycle/quest-underfilled-v2.schema';

const state = t.Union(
  questV2AssignmentStates.map((value) => t.Literal(value)) as [
    ReturnType<typeof t.Literal<string>>,
    ...ReturnType<typeof t.Literal<string>>[],
  ]
);

const questState = t.Union(
  questV2States.map((value) => t.Literal(value)) as [
    ReturnType<typeof t.Literal<string>>,
    ...ReturnType<typeof t.Literal<string>>[],
  ]
);

export const questV2AssignmentParamsSchema = t.Object({
  questId: t.String({ format: 'uuid' }),
});
export const questV2AssignmentMineQuerySchema = t.Object(
  {
    status: t.Optional(t.Union([t.Literal('active'), t.Literal('completed'), t.Literal('all')])),
  },
  { additionalProperties: false }
);

export type QuestV2AssignmentMineQuery = Static<typeof questV2AssignmentMineQuerySchema>;
export type QuestV2AssignmentMineStatus = NonNullable<QuestV2AssignmentMineQuery['status']>;

export const questV2AssignmentHeadersSchema = t.Object({
  'idempotency-key': t.String({
    minLength: 1,
    maxLength: 200,
    pattern: '\\S',
    description: 'Non-blank command identity for replay-safe Assignment and Start Work commands',
  }),
});

const assignmentSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  questId: t.String({ format: 'uuid' }),
  workerId: t.String({ format: 'uuid' }),
  member: memberSummarySchema,
  state,
  questState,
  startedAt: t.Nullable(t.String({ format: 'date-time' })),
  createdAt: t.String({ format: 'date-time' }),
});

export const questV2AssignmentResponseSchema = t.Object({
  success: t.Literal(true),
  data: assignmentSchema,
});

export const questV2StartWorkResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    questId: t.String({ format: 'uuid' }),
    assignmentId: t.String({ format: 'uuid' }),
    startedAt: t.String({ format: 'date-time' }),
    questState,
  }),
});

export const questV2AssignmentListResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    items: t.Array(assignmentSchema),
  }),
});

export const questV2MyAssignmentListResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    items: t.Array(
      t.Object({
        ...assignmentSchema.properties,
        underfilled: t.Nullable(questV2UnderfilledSummarySchema),
      })
    ),
  }),
});

export type QuestV2AssignmentParams = Static<typeof questV2AssignmentParamsSchema>;
