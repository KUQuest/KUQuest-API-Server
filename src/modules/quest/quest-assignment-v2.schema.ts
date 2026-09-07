import { t, type Static } from 'elysia';

import {
  questV2AssignmentStates,
  questV2States,
} from './quest-v2.contract';

const state = t.Union(
  questV2AssignmentStates.map((value) => t.Literal(value)) as [
    ReturnType<typeof t.Literal<string>>,
    ...ReturnType<typeof t.Literal<string>>[],
  ],
);

const questState = t.Union(
  questV2States.map((value) => t.Literal(value)) as [
    ReturnType<typeof t.Literal<string>>,
    ...ReturnType<typeof t.Literal<string>>[],
  ],
);

export const questV2AssignmentParamsSchema = t.Object({
  questId: t.String({ format: 'uuid' }),
});

export const questV2AssignmentHeadersSchema = t.Object({
  'idempotency-key': t.String({
    minLength: 1,
    maxLength: 200,
    pattern: '\\S',
    description: 'Non-blank command identity for replay-safe Quest Assignment commands',
  }),
});

const assignmentSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  questId: t.String({ format: 'uuid' }),
  workerId: t.String({ format: 'uuid' }),
  state,
  questState,
  startedAt: t.Nullable(t.String({ format: 'date-time' })),
  createdAt: t.String({ format: 'date-time' }),
});

export const questV2AssignmentResponseSchema = t.Object({
  success: t.Literal(true),
  data: assignmentSchema,
});

export const questV2AssignmentListResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    items: t.Array(assignmentSchema),
  }),
});

export type QuestV2AssignmentParams = Static<typeof questV2AssignmentParamsSchema>;
