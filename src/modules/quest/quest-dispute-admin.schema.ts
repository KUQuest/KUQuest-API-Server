import { t } from 'elysia';

const disputeCaseStatusSchema = t.Union([
  t.Literal('DISPUTE_CASE_PENDING'),
  t.Literal('DISPUTE_CASE_DISMISSED'),
  t.Literal('DISPUTE_CASE_RESOLVED'),
]);

const adminDisputeReasonCodeSchema = t.String({
  minLength: 1,
  maxLength: 100,
  pattern: '^[A-Z][A-Z0-9_.-]*$',
});

export const adminDisputeParamsSchema = t.Object({
  disputeCaseId: t.String({ format: 'uuid' }),
});

export const adminDisputeOpenParamsSchema = t.Object({
  questId: t.String({ format: 'uuid' }),
});

export const adminDisputeOpenBodySchema = t.Object({
  workerId: t.String({ format: 'uuid' }),
}, { additionalProperties: false });

export const adminDisputeListQuerySchema = t.Object({
  status: t.Optional(disputeCaseStatusSchema),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 50 })),
  cursor: t.Optional(t.String()),
  sort: t.Optional(t.Union([t.Literal('newest'), t.Literal('oldest')])),
});

const adminDisputeVersionHeaderSchema = t.String({ minLength: 1, maxLength: 100, pattern: '\\S' });
export const adminDisputeCommandHeadersSchema = t.Union([
  t.Object({
    'idempotency-key': t.String({ minLength: 1, maxLength: 200, pattern: '\\S' }),
    'if-match': adminDisputeVersionHeaderSchema,
    'x-resource-version': t.Optional(adminDisputeVersionHeaderSchema),
  }),
  t.Object({
    'idempotency-key': t.String({ minLength: 1, maxLength: 200, pattern: '\\S' }),
    'if-match': t.Optional(adminDisputeVersionHeaderSchema),
    'x-resource-version': adminDisputeVersionHeaderSchema,
  }),
]);

export const adminDisputeEvidenceHeadersSchema = t.Object({
  'idempotency-key': t.String({ minLength: 1, maxLength: 200, pattern: '\\S' }),
});

export const adminDisputeResolveBodySchema = t.Object({
  outcome: t.Union([
    t.Literal('DISPUTE_CASE_DISMISSED'),
    t.Literal('DISPUTE_CASE_RESOLVED'),
  ]),
  reasonCode: adminDisputeReasonCodeSchema,
  workerId: t.Optional(t.String({ format: 'uuid' })),
  amountSatang: t.Optional(t.Integer({ minimum: 1, maximum: 2_000_000_000 })),
}, { additionalProperties: false });

export const adminDisputeSummarySchema = t.Object({
  id: t.String({ format: 'uuid' }),
  questId: t.String({ format: 'uuid' }),
  filerUserId: t.String({ format: 'uuid' }),
  openedByAdminId: t.Nullable(t.String({ format: 'uuid' })),
  status: disputeCaseStatusSchema,
  version: t.Integer({ minimum: 1 }),
  resolvedWorkerId: t.Nullable(t.String({ format: 'uuid' })),
  resolvedAmountSatang: t.Nullable(t.Integer({ minimum: 1 })),
  resolvedByAdminId: t.Nullable(t.String({ format: 'uuid' })),
  resolvedAt: t.Nullable(t.String({ format: 'date-time' })),
  createdAt: t.String({ format: 'date-time' }),
  updatedAt: t.String({ format: 'date-time' }),
});

export const adminDisputeListResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    items: t.Array(adminDisputeSummarySchema),
    nextCursor: t.Nullable(t.String()),
  }),
});

export const adminDisputeDetailResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Intersect([
    adminDisputeSummarySchema,
    t.Object({
      quest: t.Object({
        id: t.String({ format: 'uuid' }),
        title: t.String(),
        hirerId: t.String({ format: 'uuid' }),
        questStatus: t.String(),
        version: t.Integer({ minimum: 1 }),
        failedAt: t.Nullable(t.String({ format: 'date-time' })),
        fundingReservationId: t.Nullable(t.String({ format: 'uuid' })),
      }),
    }),
  ]),
});

const adminDisputeEvidenceSchema = t.Object({
  caseId: t.String({ format: 'uuid' }),
  questId: t.String({ format: 'uuid' }),
  truncated: t.Boolean(),
  quest: t.Object({
    id: t.String({ format: 'uuid' }),
    questStatus: t.String(),
    version: t.Integer({ minimum: 1 }),
    hirerId: t.String({ format: 'uuid' }),
    failedAt: t.Nullable(t.String({ format: 'date-time' })),
  }),
  assignments: t.Array(t.Object({
    id: t.String({ format: 'uuid' }),
    workerId: t.String({ format: 'uuid' }),
    assignmentStatus: t.String(),
    startedAt: t.Nullable(t.String({ format: 'date-time' })),
    createdAt: t.String({ format: 'date-time' }),
  })),
  proofSubmissions: t.Array(t.Object({
    id: t.String({ format: 'uuid' }),
    workerId: t.Nullable(t.String({ format: 'uuid' })),
    teamId: t.Nullable(t.String({ format: 'uuid' })),
    submittedByUserId: t.String({ format: 'uuid' }),
    submissionStatus: t.String(),
    submittedAt: t.Nullable(t.String({ format: 'date-time' })),
    files: t.Array(t.Object({
      fileId: t.String({ format: 'uuid' }),
      contentType: t.String(),
      sizeBytes: t.Integer({ minimum: 0 }),
      position: t.Integer({ minimum: 0 }),
    })),
  })),
});

export const adminDisputeEvidenceResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Intersect([
    adminDisputeEvidenceSchema,
    t.Object({ adminActionId: t.String({ format: 'uuid' }) }),
  ]),
});

export const adminDisputeCommandResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    resourceSummary: adminDisputeSummarySchema,
    resourceVersion: t.Integer({ minimum: 1 }),
    adminActionId: t.String({ format: 'uuid' }),
  }),
});

export const adminDisputeOpenResponseSchema = t.Object({
  success: t.Literal(true),
  data: adminDisputeSummarySchema,
});

export type AdminDisputeListQuery = typeof adminDisputeListQuerySchema.static;
export type AdminDisputeResolveBody = typeof adminDisputeResolveBodySchema.static;
