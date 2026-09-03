import { t } from 'elysia';

import { questStatuses } from './quest.contract';
import { questV2Modes, questV2Participations } from './quest-v2.contract';

// Generic in the member type, so the schema keeps the literal union the controllers read.
const literalUnion = <T extends string>(values: readonly T[]) => t.Union(
  values.map((value) => t.Literal(value)) as [
    ReturnType<typeof t.Literal<T>>,
    ...ReturnType<typeof t.Literal<T>>[],
  ],
);

const adminQuestStatusSchema = literalUnion(questStatuses);
const adminQuestModeSchema = literalUnion(questV2Modes);
const adminQuestParticipationSchema = literalUnion(questV2Participations);

export const adminQuestParamsSchema = t.Object({ questId: t.String({ format: 'uuid' }) });
const adminQuestVersionHeaderSchema = t.String({ minLength: 1, maxLength: 100, pattern: '\\S' });
export const adminQuestCommandHeadersSchema = t.Union([
  t.Object({
    'idempotency-key': t.String({ minLength: 1, maxLength: 200, pattern: '\\S' }),
    'if-match': adminQuestVersionHeaderSchema,
    'x-resource-version': t.Optional(adminQuestVersionHeaderSchema),
  }),
  t.Object({
    'idempotency-key': t.String({ minLength: 1, maxLength: 200, pattern: '\\S' }),
    'if-match': t.Optional(adminQuestVersionHeaderSchema),
    'x-resource-version': adminQuestVersionHeaderSchema,
  }),
]);

const adminQuestReasonCodeSchema = t.String({
  minLength: 1,
  maxLength: 100,
  pattern: '^[A-Z][A-Z0-9_.-]*$',
});

export const adminQuestHideBodySchema = t.Object({
  reasonCode: adminQuestReasonCodeSchema,
}, { additionalProperties: false });

export const adminQuestRestoreBodySchema = t.Object({
  reasonCode: t.Optional(adminQuestReasonCodeSchema),
}, { additionalProperties: false });

export const adminQuestTerminateBodySchema = t.Object({
  reasonCode: adminQuestReasonCodeSchema,
}, { additionalProperties: false });

export const adminQuestListQuerySchema = t.Object({
  status: t.Optional(adminQuestStatusSchema),
  mode: t.Optional(adminQuestModeSchema),
  participation: t.Optional(adminQuestParticipationSchema),
  hidden: t.Optional(t.Boolean()),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 50 })),
  cursor: t.Optional(t.String()),
  sort: t.Optional(t.Union([t.Literal('newest'), t.Literal('oldest')])),
});

const adminQuestMemberSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  firstName: t.String(),
  lastName: t.String(),
  email: t.String(),
});

export const adminQuestSummarySchema = t.Object({
  id: t.String({ format: 'uuid' }),
  apiVersion: t.Union([t.Literal('v1'), t.Literal('v2')]),
  version: t.Integer(),
  title: t.String(),
  questStatus: adminQuestStatusSchema,
  mode: adminQuestModeSchema,
  participation: adminQuestParticipationSchema,
  headcount: t.Integer({ minimum: 1 }),
  rewardSatang: t.Nullable(t.Integer()),
  questFundingTotalSatang: t.Nullable(t.Integer()),
  startTime: t.String({ format: 'date-time' }),
  dueAt: t.Nullable(t.String({ format: 'date-time' })),
  hiddenAt: t.Nullable(t.String({ format: 'date-time' })),
  createdAt: t.String({ format: 'date-time' }),
  updatedAt: t.String({ format: 'date-time' }),
  hirer: adminQuestMemberSchema,
});
export const adminQuestCommandResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    resourceSummary: adminQuestSummarySchema,
    resourceVersion: t.Integer({ minimum: 1 }),
    adminActionId: t.String({ format: 'uuid' }),
  }),
});
export const adminQuestListResponseSchema = t.Object({

  success: t.Literal(true),
  data: t.Object({
    items: t.Array(adminQuestSummarySchema),
    nextCursor: t.Nullable(t.String()),
  }),
});

const adminQuestConditionItemSchema = t.Object({
  position: t.Integer({ minimum: 0 }),
  text: t.String(),
});

const adminQuestApplicationSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  worker: adminQuestMemberSchema,
  applicationStatus: t.String(),
  reworkLimit: t.Integer({ minimum: 0 }),
  appliedAt: t.String({ format: 'date-time' }),
});

const adminQuestTeamSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  name: t.String(),
  teamStatus: t.String(),
  reworkLimit: t.Integer({ minimum: 0 }),
  leaderId: t.String({ format: 'uuid' }),
  createdAt: t.String({ format: 'date-time' }),
  members: t.Array(
    t.Object({ member: adminQuestMemberSchema, joinedAt: t.String({ format: 'date-time' }) }),
  ),
});

const adminQuestAssignmentSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  worker: adminQuestMemberSchema,
  assignmentStatus: t.String(),
  startedAt: t.Nullable(t.String({ format: 'date-time' })),
  createdAt: t.String({ format: 'date-time' }),
});

const adminQuestProofSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  worker: t.Nullable(adminQuestMemberSchema),
  team: t.Nullable(t.Object({ id: t.String({ format: 'uuid' }), name: t.String() })),
  submittedBy: adminQuestMemberSchema,
  content: t.String(),
  submissionStatus: t.String(),
  reviewNote: t.Nullable(t.String()),
  submittedAt: t.String({ format: 'date-time' }),
  reviewedAt: t.Nullable(t.String({ format: 'date-time' })),
  files: t.Array(t.Object({
    fileId: t.String({ format: 'uuid' }),
    contentType: t.String(),
    sizeBytes: t.Integer({ minimum: 0 }),
    position: t.Integer({ minimum: 0 }),
  })),
});

const adminQuestFieldEditSchema = t.Object({
  kind: t.Literal('FIELD_EDIT'),
  id: t.String({ format: 'uuid' }),
  fieldName: t.String(),
  oldValue: t.Unknown(),
  newValue: t.Unknown(),
  editedAt: t.String({ format: 'date-time' }),
  editedByUserId: t.Nullable(t.String({ format: 'uuid' })),
  editedByAdminId: t.Nullable(t.String({ format: 'uuid' })),
});

const adminQuestEditRequestSchema = t.Object({
  kind: t.Literal('EDIT_REQUEST'),
  id: t.String({ format: 'uuid' }),
  apiVersion: t.Union([t.Literal('v1'), t.Literal('v2')]),
  requestStatus: t.String(),
  failureCode: t.Nullable(t.String()),
  requestedByUserId: t.Nullable(t.String({ format: 'uuid' })),
  proposedChanges: t.Unknown(),
  createdAt: t.String({ format: 'date-time' }),
  expiresAt: t.Nullable(t.String({ format: 'date-time' })),
  resolvedAt: t.Nullable(t.String({ format: 'date-time' })),
  responses: t.Array(t.Object({
    workerId: t.String({ format: 'uuid' }),
    decision: t.Nullable(t.String()),
    reason: t.Nullable(t.String()),
    respondedAt: t.Nullable(t.String({ format: 'date-time' })),
  })),
});

const adminQuestEditHistoryEntrySchema = t.Union([
  adminQuestFieldEditSchema,
  adminQuestEditRequestSchema,
]);

const adminActionEntrySchema = t.Object({
  id: t.String({ format: 'uuid' }),
  admin: t.Object({
    id: t.String({ format: 'uuid' }),
    firstName: t.String(),
    lastName: t.String(),
  }),
  action: t.String(),
  reasonCode: t.Nullable(t.String()),
  createdAt: t.String({ format: 'date-time' }),
});

export const adminQuestDetailSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  apiVersion: t.Union([t.Literal('v1'), t.Literal('v2')]),
  version: t.Integer(),
  title: t.String(),
  description: t.Nullable(t.String()),
  condition: t.Object({
    text: t.String(),
    items: t.Array(adminQuestConditionItemSchema),
  }),
  questStatus: adminQuestStatusSchema,
  mode: adminQuestModeSchema,
  participation: adminQuestParticipationSchema,
  headcount: t.Integer({ minimum: 1 }),
  proofRequired: t.Boolean(),
  tagId: t.Nullable(t.String({ format: 'uuid' })),
  rewardSatang: t.Nullable(t.Integer()),
  questFundingTotalSatang: t.Nullable(t.Integer()),
  fundingReservationId: t.Nullable(t.String({ format: 'uuid' })),
  policyRevisionId: t.Nullable(t.String({ format: 'uuid' })),
  platformFeeBps: t.Nullable(t.Integer()),
  platformFeePerWorkerSatang: t.Nullable(t.Integer()),
  questEscrowSatang: t.Nullable(t.Integer()),
  startTime: t.String({ format: 'date-time' }),
  dueAt: t.Nullable(t.String({ format: 'date-time' })),
  cancelledAt: t.Nullable(t.String({ format: 'date-time' })),
  cancelledByUserId: t.Nullable(t.String({ format: 'uuid' })),
  cancelledByAdminId: t.Nullable(t.String({ format: 'uuid' })),
  hiddenAt: t.Nullable(t.String({ format: 'date-time' })),
  hiddenByAdminId: t.Nullable(t.String({ format: 'uuid' })),
  createdAt: t.String({ format: 'date-time' }),
  updatedAt: t.String({ format: 'date-time' }),
  hirer: adminQuestMemberSchema,
  candidates: t.Object({
    applications: t.Array(adminQuestApplicationSchema),
    teams: t.Array(adminQuestTeamSchema),
  }),
  assignments: t.Array(adminQuestAssignmentSchema),
  proofSubmissions: t.Array(adminQuestProofSchema),
  editHistory: t.Array(adminQuestEditHistoryEntrySchema),
  adminActions: t.Array(adminActionEntrySchema),
});

export const adminQuestDetailResponseSchema = t.Object({
  success: t.Literal(true),
  data: adminQuestDetailSchema,
});
