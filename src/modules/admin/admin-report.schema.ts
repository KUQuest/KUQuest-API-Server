import { MAX_PAGE_LIMIT } from '@/shared/cursor';

import { t, type Static } from 'elysia';

import {
  conductReportDismissReasonCodes,
  conductReportUpholdReasonCodes,
  reportCaseDismissReasonCodes,
  reportCaseHideReasonCodes,
  reportCaseRestoreReasonCodes,
} from './admin-report.policy';
import { adminDecisionReasonTextSchema } from './admin-action.schema';

const dateTime = t.String({ format: 'date-time' });
const uuid = t.String({ format: 'uuid' });

const questModeSchema = t.Union([t.Literal('FIRST_COME_FIRST_SERVED'), t.Literal('CANDIDATE')]);

const questParticipationSchema = t.Union([t.Literal('SINGLE'), t.Literal('GROUP')]);

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

const reportCaseDismissReasonCodeSchema = t.Union([
  t.Literal(reportCaseDismissReasonCodes[0]),
  t.Literal(reportCaseDismissReasonCodes[1]),
  t.Literal(reportCaseDismissReasonCodes[2]),
]);

const reportCaseHideReasonCodeSchema = t.Union([
  t.Literal(reportCaseHideReasonCodes[0]),
  t.Literal(reportCaseHideReasonCodes[1]),
  t.Literal(reportCaseHideReasonCodes[2]),
  t.Literal(reportCaseHideReasonCodes[3]),
  t.Literal(reportCaseHideReasonCodes[4]),
]);

const reportCaseRestoreReasonCodeSchema = t.Union([
  t.Literal(reportCaseRestoreReasonCodes[0]),
  t.Literal(reportCaseRestoreReasonCodes[1]),
  t.Literal(reportCaseRestoreReasonCodes[2]),
]);

const conductReportDismissDecisionReasonCodeSchema = t.Union([
  t.Literal(conductReportDismissReasonCodes[0]),
  t.Literal(conductReportDismissReasonCodes[1]),
  t.Literal(conductReportDismissReasonCodes[2]),
  t.Literal(conductReportDismissReasonCodes[3]),
]);

const conductReportUpholdDecisionReasonCodeSchema = t.Union([
  t.Literal(conductReportUpholdReasonCodes[0]),
  t.Literal(conductReportUpholdReasonCodes[1]),
  t.Literal(conductReportUpholdReasonCodes[2]),
]);

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
  q: t.Optional(t.String({ maxLength: 200 })),
  kind: t.Optional(reportKindSchema),
  status: t.Optional(t.Union([reportCaseStatusSchema, conductReportStatusSchema])),
  statusMode: t.Optional(
    t.Union([t.Literal('OPEN_QUEUE'), t.Literal('FULL_HISTORY')], {
      description:
        'OPEN_QUEUE is the default. FULL_HISTORY includes every Report Case and Conduct Report status. An exact status filter takes precedence.',
    })
  ),
  memberId: t.Optional(uuid),
  submittedByMemberId: t.Optional(uuid),
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

export const adminReportCaseDismissDecisionBodySchema = t.Object(
  {
    outcome: t.Literal('REPORT_CASE_DISMISSED'),
    reasonCode: reportCaseDismissReasonCodeSchema,
    decisionReasonText: adminDecisionReasonTextSchema,
  },
  { additionalProperties: false }
);

export const adminReportCaseHideDecisionBodySchema = t.Object(
  {
    outcome: t.Literal('REPORT_CASE_HIDDEN'),
    reasonCode: reportCaseHideReasonCodeSchema,
    decisionReasonText: adminDecisionReasonTextSchema,
  },
  { additionalProperties: false }
);

export const adminReportCaseRestoreDecisionBodySchema = t.Object(
  {
    outcome: t.Literal('REPORT_CASE_RESTORED'),
    reasonCode: reportCaseRestoreReasonCodeSchema,
    decisionReasonText: adminDecisionReasonTextSchema,
  },
  { additionalProperties: false }
);

export const adminReportCaseDecisionBodySchema = t.Union([
  adminReportCaseDismissDecisionBodySchema,
  adminReportCaseHideDecisionBodySchema,
  adminReportCaseRestoreDecisionBodySchema,
]);

export const adminConductReportDismissDecisionBodySchema = t.Object(
  {
    outcome: t.Literal('CONDUCT_REPORT_DISMISSED'),
    decisionReasonCode: conductReportDismissDecisionReasonCodeSchema,
    decisionReasonText: adminDecisionReasonTextSchema,
  },
  { additionalProperties: false }
);

export const adminConductReportUpholdDecisionBodySchema = t.Object(
  {
    outcome: t.Literal('CONDUCT_REPORT_UPHELD'),
    decisionReasonCode: conductReportUpholdDecisionReasonCodeSchema,
    decisionReasonText: adminDecisionReasonTextSchema,
  },
  { additionalProperties: false }
);

export const adminConductReportDecisionBodySchema = t.Union([
  adminConductReportDismissDecisionBodySchema,
  adminConductReportUpholdDecisionBodySchema,
]);

export const adminReportDecisionBodySchema = t.Union([
  adminReportCaseDecisionBodySchema,
  adminConductReportDecisionBodySchema,
]);
const adminReportMemberSummarySchema = t.Object({
  id: uuid,
  displayId: t.String({ pattern: '^MEM-[0-9]{6,}$' }),
  email: t.String(),
  firstName: t.String(),
  lastName: t.String(),
  studentId: t.Nullable(t.String()),
});

const adminReportQuestSummarySchema = t.Object({
  id: uuid,
  displayId: t.String({ pattern: '^QST-[0-9]{6,}$' }),
  title: t.String(),
  questStatus: questStatusSchema,
  mode: questModeSchema,
  participation: questParticipationSchema,
});

const reportCaseSourceSchema = t.Union(
  [t.Literal('CONVERSATION_CANDIDATE_INQUIRY'), t.Literal('CONVERSATION_WORK')],
  { description: 'Conversation type that contains the reported Message.' }
);

const reportCaseTypeSchema = t.Union([t.Literal('USER'), t.Literal('SYSTEM')], {
  description: 'Kind of the reported Message.',
});

const adminReporterSummarySchema = t.Object({
  id: uuid,
  reporterMemberId: uuid,
  reporter: adminReportMemberSummarySchema,
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

const adminReportMemberSchema = adminReportMemberSummarySchema;

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
  displayId: t.String({ pattern: '^RPT-[0-9]{6,}$' }),
  messageId: uuid,
  conversationId: uuid,
  questId: uuid,
  source: reportCaseSourceSchema,
  type: reportCaseTypeSchema,
  reportedMember: t.Nullable(adminReportMemberSummarySchema),
  quest: t.Nullable(adminReportQuestSummarySchema),
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

const adminConductReportAdminSummarySchema = t.Object({
  id: uuid,
  email: t.String(),
  firstName: t.String(),
  lastName: t.String(),
});

const adminConductReportDecisionSchema = t.Union([
  t.Object({
    outcome: t.Literal('CONDUCT_REPORT_UPHELD'),
    reason: t.Nullable(
      t.Union([conductReportReasonSchema, conductReportUpholdDecisionReasonCodeSchema])
    ),
    resolvedAt: dateTime,
    admin: adminConductReportAdminSummarySchema,
  }),
  t.Object({
    outcome: t.Literal('CONDUCT_REPORT_DISMISSED'),
    reason: t.Nullable(conductReportDismissDecisionReasonCodeSchema),
    resolvedAt: dateTime,
    admin: adminConductReportAdminSummarySchema,
  }),
]);

export const adminConductReportDetailSchema = t.Composite([
  adminConductReportSummarySchema,
  t.Object({
    assignment: adminConductReportAssignmentSchema,
    proofSubmission: t.Nullable(adminConductReportProofSchema),
    decision: t.Nullable(adminConductReportDecisionSchema),
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
    totalCount: t.Integer({ minimum: 0 }),
    countsByStatus: t.Object({
      REPORT_CASE_PENDING: t.Integer({ minimum: 0 }),
      REPORT_CASE_DISMISSED: t.Integer({ minimum: 0 }),
      REPORT_CASE_HIDDEN: t.Integer({ minimum: 0 }),
      REPORT_CASE_RESTORED: t.Integer({ minimum: 0 }),
      CONDUCT_REPORT_PENDING: t.Integer({ minimum: 0 }),
      CONDUCT_REPORT_UPHELD: t.Integer({ minimum: 0 }),
      CONDUCT_REPORT_DISMISSED: t.Integer({ minimum: 0 }),
    }),
  }),
});

export const adminReportDetailResponseSchema = t.Object({
  success: t.Literal(true),
  data: adminReportDetailSchema,
});

const adminReportCaseCommandSummarySchema = t.Object({
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

const adminConductReportCommandSummarySchema = t.Object({
  kind: t.Literal('CONDUCT_REPORT'),
  id: uuid,
  displayId: t.String({ pattern: '^CND-[0-9]{6,}$' }),
  status: conductReportStatusSchema,
  version: t.Integer({ minimum: 1 }),
  updatedAt: dateTime,
  resolvedAt: t.Nullable(dateTime),
});

const adminReportCommandSummarySchema = t.Union([
  adminReportCaseCommandSummarySchema,
  adminConductReportCommandSummarySchema,
]);

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
export type AdminReportCaseSummary = Static<typeof adminReportCaseSummarySchema>;
export type AdminConductReportSummary = Static<typeof adminConductReportSummarySchema>;
export type AdminConductReportDetail = Static<typeof adminConductReportDetailSchema>;
export type AdminReportListData = Static<typeof adminReportListResponseSchema>['data'];
export type AdminReportDetailData = Static<typeof adminReportDetailResponseSchema>['data'];
export type AdminConductReportCommandSummary = Static<
  typeof adminConductReportCommandSummarySchema
>;
export type AdminReportCommandSummary = Static<typeof adminReportCommandSummarySchema>;
export type AdminReportCommandData = Static<typeof adminReportCommandResponseSchema>['data'];
export type AdminReportEvidenceData = Static<typeof adminReportEvidenceResponseSchema>['data'];
