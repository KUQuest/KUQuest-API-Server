import { t, type Static } from 'elysia';

import {
  questV2ApplicationStates,
  questV2AssignmentStates,
} from './quest-v2.contract';

const applicationState = t.Union(
  questV2ApplicationStates.map((value) => t.Literal(value)) as [
    ReturnType<typeof t.Literal<string>>,
    ...ReturnType<typeof t.Literal<string>>[],
  ],
);

export const questV2CandidateApplicationParamsSchema = t.Object({
  questId: t.String({ format: 'uuid' }),
});

export const questV2CandidateApplicationDetailParamsSchema = t.Object({
  questId: t.String({ format: 'uuid' }),
  applicationId: t.String({ format: 'uuid' }),
});

export const questV2CandidateApplicationHeadersSchema = t.Object({
  'idempotency-key': t.String({
    minLength: 1,
    maxLength: 200,
    pattern: '\\S',
    description: 'Non-blank command identity for replay-safe Candidate application commands',
  }),
});

const applicationSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  questId: t.String({ format: 'uuid' }),
  memberId: t.String({ format: 'uuid' }),
  state: applicationState,
  appliedAt: t.String({ format: 'date-time' }),
});

const assignmentState = t.Union(
  questV2AssignmentStates.map((value) => t.Literal(value)) as [
    ReturnType<typeof t.Literal<string>>,
    ...ReturnType<typeof t.Literal<string>>[],
  ],
);

const selectionAssignmentSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  questId: t.String({ format: 'uuid' }),
  workerId: t.String({ format: 'uuid' }),
  state: assignmentState,
  questState: t.Literal('QUEST_ASSIGNED'),
  startedAt: t.Nullable(t.String({ format: 'date-time' })),
  createdAt: t.String({ format: 'date-time' }),
});

export const questV2CandidateApplicationResponseSchema = t.Object({
  success: t.Literal(true),
  data: applicationSchema,
});

export const questV2CandidateApplicationListResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    items: t.Array(applicationSchema),
  }),
});

export const questV2CandidateSelectionParamsSchema = t.Object({
  questId: t.String({ format: 'uuid' }),
  applicationId: t.String({ format: 'uuid' }),
});

export const questV2CandidateSelectionResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    assignments: t.Array(selectionAssignmentSchema),
    questState: t.Literal('QUEST_ASSIGNED'),
  }),
});

export type QuestV2CandidateApplicationParams = Static<typeof questV2CandidateApplicationParamsSchema>;
export type QuestV2CandidateApplicationDetailParams = Static<typeof questV2CandidateApplicationDetailParamsSchema>;
export type QuestV2CandidateSelectionParams = Static<typeof questV2CandidateSelectionParamsSchema>;
