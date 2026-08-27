import { t } from 'elysia';

import { assignmentStatuses, questStatuses } from './quest.contract';

const status = t.Union(
  assignmentStatuses.map((value) => t.Literal(value)) as [
    ReturnType<typeof t.Literal<string>>,
    ...ReturnType<typeof t.Literal<string>>[],
  ],
);

export const questAssignmentParamsSchema = t.Object({
  questId: t.String({ format: 'uuid' }),
});

export const questAssignmentHeadersSchema = t.Object({
  'idempotency-key': t.String({
    minLength: 1,
    maxLength: 200,
    pattern: '\\S',
    description: 'Non-blank command identity for replay-safe direct joins',
  }),
});

const assignmentSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  questId: t.String({ format: 'uuid' }),
  workerId: t.String({ format: 'uuid' }),
  assignmentStatus: status,
  startedAt: t.Nullable(t.String({ format: 'date-time' })),
  createdAt: t.String({ format: 'date-time' }),
});

const questStatus = t.Union(
  questStatuses.map((value) => t.Literal(value)) as [
    ReturnType<typeof t.Literal<string>>,
    ...ReturnType<typeof t.Literal<string>>[],
  ],
);

export const questAssignmentResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Intersect([assignmentSchema, t.Object({ questStatus })]),
});

export type QuestAssignmentParams = typeof questAssignmentParamsSchema.static;
