import { MAX_PAGE_LIMIT } from '@/shared/cursor';

import { t, type Static } from 'elysia';

const dateTime = t.String({ format: 'date-time' });
const uuid = t.String({ format: 'uuid' });

const reportCaseStatusSchema = t.Union([
  t.Literal('REPORT_CASE_PENDING'),
  t.Literal('REPORT_CASE_DISMISSED'),
  t.Literal('REPORT_CASE_HIDDEN'),
  t.Literal('REPORT_CASE_RESTORED'),
]);

const conductReportStatusSchema = t.Union([
  t.Literal('CONDUCT_REPORT_PENDING'),
  t.Literal('CONDUCT_REPORT_UPHELD'),
  t.Literal('CONDUCT_REPORT_DISMISSED'),
]);

const conductReportReasonSchema = t.Union([
  t.Literal('CONDUCT_ABANDONED'),
  t.Literal('CONDUCT_OUT_OF_SCOPE'),
  t.Literal('CONDUCT_NO_SHOW'),
]);

const reportKindSchema = t.Union([t.Literal('REPORT_CASE'), t.Literal('CONDUCT_REPORT')]);

const questModeSchema = t.Union([t.Literal('FIRST_COME_FIRST_SERVED'), t.Literal('CANDIDATE')]);

const questParticipationSchema = t.Union([t.Literal('SINGLE'), t.Literal('GROUP')]);

const questStatusSchema = t.Union([
  t.Literal('QUEST_DRAFT'),
  t.Literal('QUEST_OPEN'),
  t.Literal('QUEST_AWAITING_CONSENT'),
  t.Literal('QUEST_ASSIGNED'),
  t.Literal('QUEST_IN_PROGRESS'),
  t.Literal('QUEST_SUBMITTED'),
  t.Literal('QUEST_APPROVED'),
  t.Literal('QUEST_REWORK'),
  t.Literal('QUEST_COMPLETED'),
  t.Literal('QUEST_CANCELLED'),
  t.Literal('QUEST_DISPUTED'),
  t.Literal('QUEST_FAILED'),
]);

const reporterEntryReasonSchema = t.Union([
  t.Literal('REPORT_ABUSIVE_OR_HARASSMENT'),
  t.Literal('REPORT_SPAM'),
  t.Literal('REPORT_INAPPROPRIATE_CONTENT'),
  t.Literal('REPORT_DANGER_OR_THREAT'),
  t.Literal('REPORT_OTHER'),
]);

const adminReportReasonCodeSchema = t.String({
  minLength: 1,
  maxLength: 100,
  pattern: '^[A-Z][A-Z0-9_.-]*$',
});

export const adminReportParamsSchema = t.Object({
  reportId: uuid,
});

export const adminReportEvidenceParamsSchema = t.Object({
  evidenceRef: t.String({
    pattern:
      '^(?:[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}|CRH_[A-Za-z0-9_-]{43})$',
  }),
});

export const adminReportEvidenceQuerySchema = t.Object({
  limit: t.Optional(t.Integer({ minimum: 1, maximum: MAX_PAGE_LIMIT })),
  cursor: t.Optional(t.String()),
});

export const adminReportListQuerySchema = t.Object({
  kind: t.Optional(reportKindSchema),
  status: t.Optional(t.Union([reportCaseStatusSchema, conductReportStatusSchema])),
  memberId: t.Optional(uuid),
  questId: t.Optional(uuid),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: MAX_PAGE_LIMIT })),
  cursor: t.Optional(t.String()),
  sort: t.Optional(t.Union([t.Literal('newest'), t.Literal('oldest')])),
});

const adminReportCommandVersionHeaderSchema = t.String({
  minLength: 1,
  maxLength: 100,
  pattern: '\\S',
});

export const adminReportCommandHeadersSchema = t.Union([
  t.Object({
    'idempotency-key': t.String({ minLength: 1, maxLength: 200, pattern: '\\S' }),
    'if-match': adminReportCommandVersionHeaderSchema,
    'x-resource-version': t.Optional(adminReportCommandVersionHeaderSchema),
  }),
  t.Object({
    'idempotency-key': t.String({ minLength: 1, maxLength: 200, pattern: '\\S' }),
    'if-match': t.Optional(adminReportCommandVersionHeaderSchema),
    'x-resource-version': adminReportCommandVersionHeaderSchema,
  }),
]);

export const adminReportEvidenceHeadersSchema = t.Object({
  'idempotency-key': t.String({ minLength: 1, maxLength: 200, pattern: '\\S' }),
});

export const adminReportDecisionBodySchema = t.Object(
  {
    outcome: t.Union([
      t.Literal('REPORT_CASE_DISMISSED'),
      t.Literal('REPORT_CASE_HIDDEN'),
      t.Literal('REPORT_CASE_RESTORED'),
    ]),
    reasonCode: adminReportReasonCodeSchema,
  },
  { additionalProperties: false }
);

const adminReporterSummarySchema = t.Object({
  id: uuid,
  reporterMemberId: uuid,
  reporter: t.Object({
    id: uuid,
    email: t.String(),
    firstName: t.String(),
    lastName: t.String(),
  }),
  reason: reporterEntryReasonSchema,
  detail: t.Nullable(t.String()),
  createdAt: dateTime,
});

const adminEvidenceReferenceSummarySchema = t.Object({
  id: uuid,
  messageId: t.Nullable(uuid),
  attachmentId: t.Nullable(uuid),
  createdAt: dateTime,
});

const adminReportMemberSchema = t.Object({
  id: uuid,
  email: t.String(),
  firstName: t.String(),
  lastName: t.String(),
});

const adminConductReportQuestSchema = t.Object({
  id: uuid,
  displayId: t.String({ pattern: '^QST-[0-9]{6,}$' }),
  title: t.String(),
  questStatus: questStatusSchema,
  mode: questModeSchema,
  participation: questParticipationSchema,
  headcount: t.Integer({ minimum: 1 }),
  proofRequired: t.Boolean(),
  startTime: dateTime,
  dueAt: t.Nullable(dateTime),
  createdAt: dateTime,
  updatedAt: dateTime,
  hirer: adminReportMemberSchema,
});

export const adminConductReportSummarySchema = t.Object({
  kind: t.Literal('CONDUCT_REPORT'),
  id: uuid,
  displayId: t.String({ pattern: '^CND-[0-9]{6,}$' }),
  filer: adminReportMemberSchema,
  reportedMember: adminReportMemberSchema,
  quest: adminConductReportQuestSchema,
  reason: conductReportReasonSchema,
  detail: t.Nullable(t.String()),
  status: conductReportStatusSchema,
  version: t.Integer({ minimum: 1 }),
  createdAt: dateTime,
  updatedAt: dateTime,
  resolvedAt: t.Nullable(dateTime),
});

export const adminReportCaseSummarySchema = t.Object({
  kind: t.Literal('REPORT_CASE'),
  id: uuid,
  displayId: t.String(),
  messageId: uuid,
  conversationId: uuid,
  questId: uuid,
  status: reportCaseStatusSchema,
  version: t.Integer({ minimum: 1 }),
  caseClosedAt: t.Nullable(dateTime),
  createdAt: dateTime,
  updatedAt: dateTime,
  reporterEntries: t.Array(adminReporterSummarySchema),
  evidenceReferences: t.Array(adminEvidenceReferenceSummarySchema),
});

const adminConductReportAssignmentSchema = t.Object({
  id: uuid,
  worker: adminReportMemberSchema,
  assignmentStatus: t.Union([
    t.Literal('ASSIGNMENT_ACTIVE'),
    t.Literal('ASSIGNMENT_COMPLETED'),
    t.Literal('ASSIGNMENT_INCOMPLETE'),
    t.Literal('ASSIGNMENT_CANCELLED'),
  ]),
  startedAt: t.Nullable(dateTime),
  createdAt: dateTime,
});

const adminConductReportProofSchema = t.Object({
  id: uuid,
  workerId: t.Nullable(uuid),
  teamId: t.Nullable(uuid),
  submittedBy: adminReportMemberSchema,
  description: t.Nullable(t.String()),
  workerMessage: t.Nullable(t.String()),
  content: t.Nullable(t.String()),
  submissionStatus: t.Nullable(
    t.Union([
      t.Literal('PROOF_PENDING'),
      t.Literal('PROOF_APPROVED'),
      t.Literal('PROOF_NOT_APPROVED'),
    ])
  ),
  reviewNote: t.Nullable(t.String()),
  sentAt: t.Nullable(dateTime),
  submittedAt: t.Nullable(dateTime),
  reviewedAt: t.Nullable(dateTime),
  createdAt: dateTime,
  updatedAt: t.Nullable(dateTime),
});

export const adminConductReportDetailSchema = t.Composite([
  adminConductReportSummarySchema,
  t.Object({
    assignment: adminConductReportAssignmentSchema,
    proofSubmission: t.Nullable(adminConductReportProofSchema),
    evidenceHandles: t.Array(
      t.Object({
        handle: t.String({ pattern: '^CRH_[A-Za-z0-9_-]{43}$' }),
        conversationType: t.Union([
          t.Literal('CONVERSATION_WORK'),
          t.Literal('CONVERSATION_CANDIDATE_INQUIRY'),
        ]),
        candidate: t.Nullable(adminReportMemberSchema),
        expiresAt: t.Nullable(dateTime),
      })
    ),
  }),
]);

const adminReportListItemSchema = t.Union([
  adminReportCaseSummarySchema,
  adminConductReportSummarySchema,
]);

const adminReportDetailSchema = t.Union([
  adminReportCaseSummarySchema,
  adminConductReportDetailSchema,
]);

export const adminReportListResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    items: t.Array(adminReportListItemSchema),
    nextCursor: t.Nullable(t.String()),
  }),
});

export const adminReportDetailResponseSchema = t.Object({
  success: t.Literal(true),
  data: adminReportDetailSchema,
});

const adminReportCommandSummarySchema = t.Object({
  id: uuid,
  displayId: t.String(),
  kind: t.Literal('REPORT_CASE'),
  status: reportCaseStatusSchema,
  version: t.Integer({ minimum: 1 }),
  reporterEntryCount: t.Integer({ minimum: 0 }),
  referenceCount: t.Integer({ minimum: 0 }),
  caseClosedAt: t.Nullable(dateTime),
  updatedAt: dateTime,
});

export const adminReportCommandResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    resourceSummary: adminReportCommandSummarySchema,
    resourceVersion: t.Integer({ minimum: 1 }),
    adminActionId: uuid,
  }),
});

const adminReportEvidenceAttachmentSchema = t.Object({
  id: uuid,
  status: t.Union([
    t.Literal('QUARANTINED'),
    t.Literal('VALIDATED'),
    t.Literal('REJECTED'),
    t.Literal('CONSUMED'),
    t.Literal('HIDDEN'),
    t.Literal('EXPIRED'),
  ]),
  originalFilename: t.String(),
  mimeType: t.String(),
  sizeBytes: t.Integer({ minimum: 0 }),
  url: t.Nullable(t.String({ format: 'uri' })),
  urlExpiresAt: t.Nullable(dateTime),
});

const adminReportEvidenceMessageSchema = t.Object({
  id: uuid,
  conversationId: uuid,
  sequence: t.Integer({ minimum: 1 }),
  kind: t.Union([t.Literal('USER'), t.Literal('SYSTEM')]),
  sender: t.Nullable(
    t.Object({
      id: uuid,
      email: t.String(),
      firstName: t.String(),
      lastName: t.String(),
    })
  ),
  contentText: t.Nullable(t.String()),
  systemType: t.Nullable(t.String()),
  systemPayload: t.Nullable(t.Record(t.String(), t.Any())),
  createdAt: dateTime,
  attachments: t.Array(adminReportEvidenceAttachmentSchema),
});

const adminReportCaseEvidenceSchema = t.Object({
  caseId: uuid,
  evidenceRefId: uuid,
  reportedMessageId: uuid,
  truncated: t.Boolean(),
  messages: t.Array(adminReportEvidenceMessageSchema),
});

const adminConductReportEvidenceSchema = t.Object({
  conductReportId: uuid,
  evidenceHandle: t.String({ pattern: '^CRH_[A-Za-z0-9_-]{43}$' }),
  conversationType: t.Union([
    t.Literal('CONVERSATION_WORK'),
    t.Literal('CONVERSATION_CANDIDATE_INQUIRY'),
  ]),
  expiresAt: t.Nullable(dateTime),
  messages: t.Array(adminReportEvidenceMessageSchema),
  nextCursor: t.Nullable(t.String()),
  adminActionId: uuid,
});

export const adminReportEvidenceResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Union([
    t.Composite([adminReportCaseEvidenceSchema, t.Object({ adminActionId: uuid })]),
    adminConductReportEvidenceSchema,
  ]),
});

export type AdminReportParams = Static<typeof adminReportParamsSchema>;
export type AdminReportEvidenceParams = Static<typeof adminReportEvidenceParamsSchema>;
export type AdminReportEvidenceQuery = Static<typeof adminReportEvidenceQuerySchema>;
export type AdminReportListQuery = Static<typeof adminReportListQuerySchema>;
export type AdminReportDecisionBody = Static<typeof adminReportDecisionBodySchema>;
export type AdminReportListData = Static<typeof adminReportListResponseSchema>['data'];
export type AdminReportDetailData = Static<typeof adminReportDetailResponseSchema>['data'];
export type AdminConductReportSummary = Static<typeof adminConductReportSummarySchema>;
export type AdminConductReportDetail = Static<typeof adminConductReportDetailSchema>;
export type AdminReportCommandData = Static<typeof adminReportCommandResponseSchema>['data'];
export type AdminReportEvidenceData = Static<typeof adminReportEvidenceResponseSchema>['data'];
