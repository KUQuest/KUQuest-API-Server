import { MAX_PAGE_LIMIT } from '@/shared/cursor';

import { t } from 'elysia';

const reporterEntryReasonSchema = t.Union([
  t.Literal('REPORT_ABUSIVE_OR_HARASSMENT'),
  t.Literal('REPORT_SPAM'),
  t.Literal('REPORT_INAPPROPRIATE_CONTENT'),
  t.Literal('REPORT_DANGER_OR_THREAT'),
  t.Literal('REPORT_OTHER'),
]);

const reportCaseStatusSchema = t.Union([
  t.Literal('REPORT_CASE_PENDING'),
  t.Literal('REPORT_CASE_DISMISSED'),
  t.Literal('REPORT_CASE_HIDDEN'),
  t.Literal('REPORT_CASE_RESTORED'),
]);

const reporterEntrySchema = t.Object({
  id: t.String({ format: 'uuid' }),
  messageId: t.String({ format: 'uuid' }),
  reason: reporterEntryReasonSchema,
  detail: t.Nullable(t.String()),
  caseStatus: reportCaseStatusSchema,
  createdAt: t.String({ format: 'date-time' }),
  updatedAt: t.String({ format: 'date-time' }),
});

export const messageReportParamsSchema = t.Object({
  reporterEntryId: t.String({ format: 'uuid' }),
});

export const submitMessageReportSchema = t.Object(
  {
    messageId: t.String({ format: 'uuid' }),
    reason: reporterEntryReasonSchema,
    detail: t.Optional(t.String({ minLength: 1, maxLength: 1000, pattern: '\\S' })),
  },
  { additionalProperties: false }
);

export const messageReportListQuerySchema = t.Object(
  {
    limit: t.Optional(t.Integer({ minimum: 1, maximum: MAX_PAGE_LIMIT })),
    cursor: t.Optional(t.String()),
  },
  { additionalProperties: false }
);

export const messageReportResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({ reporterEntry: reporterEntrySchema }),
});

export const messageReportListResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    items: t.Array(reporterEntrySchema),
    nextCursor: t.Nullable(t.String()),
  }),
});

export type MessageReportParams = typeof messageReportParamsSchema.static;
export type SubmitMessageReportInput = typeof submitMessageReportSchema.static;
export type MessageReportListQuery = typeof messageReportListQuerySchema.static;
