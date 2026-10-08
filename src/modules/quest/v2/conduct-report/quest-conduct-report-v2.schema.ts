import { t, type Static } from 'elysia';

const conductReportReasonSchema = t.Union([
  t.Literal('CONDUCT_ABANDONED'),
  t.Literal('CONDUCT_OUT_OF_SCOPE'),
  t.Literal('CONDUCT_NO_SHOW'),
]);

const conductReportStatusSchema = t.Union([
  t.Literal('CONDUCT_REPORT_PENDING'),
  t.Literal('CONDUCT_REPORT_UPHELD'),
  t.Literal('CONDUCT_REPORT_DISMISSED'),
]);

export const questV2ConductReportParamsSchema = t.Object({
  questId: t.String({ format: 'uuid' }),
});

export const questV2ConductReportHeadersSchema = t.Object(
  {
    'idempotency-key': t.String({
      minLength: 1,
      maxLength: 200,
      pattern: '\\S',
      description: 'Non-blank command identity for a replay-safe Conduct Report filing',
    }),
  },
  { additionalProperties: true }
);

export const questV2ConductReportCreateSchema = t.Object(
  {
    reportedMemberId: t.String({ format: 'uuid' }),
    reason: conductReportReasonSchema,
    detail: t.Optional(t.String({ minLength: 1, maxLength: 1000, pattern: '\\S' })),
  },
  { additionalProperties: false }
);

const questV2ConductReportItemSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  displayId: t.String(),
  questId: t.String({ format: 'uuid' }),
  reportedMemberId: t.String({ format: 'uuid' }),
  reason: conductReportReasonSchema,
  detail: t.Nullable(t.String()),
  status: conductReportStatusSchema,
  createdAt: t.String({ format: 'date-time' }),
});

const questV2ReportableSchema = t.Object({
  memberId: t.String({ format: 'uuid' }),
  reason: conductReportReasonSchema,
});

export const questV2ConductReportResponseSchema = t.Object({
  success: t.Literal(true),
  data: questV2ConductReportItemSchema,
});

export const questV2ConductReportListResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    windowEndsAt: t.Nullable(
      t.String({
        format: 'date-time',
        description:
          'One day after the Quest became Terminal. Null while the Quest is not Terminal or before the filing window opens.',
      })
    ),
    reportable: t.Array(questV2ReportableSchema, {
      description:
        'The Conduct Reports the caller can file now. Empty when the filing window is closed.',
    }),
    items: t.Array(questV2ConductReportItemSchema, {
      description: 'The caller’s own Conduct Reports on this Quest.',
    }),
  }),
});

export type QuestV2ConductReportParams = Static<typeof questV2ConductReportParamsSchema>;
export type QuestV2ConductReportCreateInput = Static<typeof questV2ConductReportCreateSchema>;
