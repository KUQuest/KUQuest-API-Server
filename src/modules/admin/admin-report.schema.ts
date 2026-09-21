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
  evidenceRef: uuid,
});

export const adminReportListQuerySchema = t.Object({
  kind: t.Optional(t.Literal('REPORT_CASE')),
  status: t.Optional(reportCaseStatusSchema),
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

export const adminReportListResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    items: t.Array(adminReportCaseSummarySchema),
    nextCursor: t.Nullable(t.String()),
  }),
});

export const adminReportDetailResponseSchema = t.Object({
  success: t.Literal(true),
  data: adminReportCaseSummarySchema,
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

export const adminReportEvidenceResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    caseId: uuid,
    evidenceRefId: uuid,
    reportedMessageId: uuid,
    truncated: t.Boolean(),
    messages: t.Array(adminReportEvidenceMessageSchema),
    adminActionId: uuid,
  }),
});

export type AdminReportParams = Static<typeof adminReportParamsSchema>;
export type AdminReportEvidenceParams = Static<typeof adminReportEvidenceParamsSchema>;
export type AdminReportListQuery = Static<typeof adminReportListQuerySchema>;
export type AdminReportDecisionBody = Static<typeof adminReportDecisionBodySchema>;
export type AdminReportListData = Static<typeof adminReportListResponseSchema>['data'];
export type AdminReportDetailData = Static<typeof adminReportDetailResponseSchema>['data'];
export type AdminReportCommandData = Static<typeof adminReportCommandResponseSchema>['data'];
export type AdminReportEvidenceData = Static<typeof adminReportEvidenceResponseSchema>['data'];
