import { enabledAdminGuard } from '@/modules/auth';
import { API_V1_PREFIX } from '@/shared/api-version';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { rejectUnknownFields } from '@/shared/reject-unknown-fields';

import { Elysia } from 'elysia';

import {
  decideAdminReportController,
  getAdminReportController,
  getAdminReportEvidenceController,
  listAdminReportsController,
} from './admin-report.controller';
import {
  adminReportCommandHeadersSchema,
  adminReportCommandResponseSchema,
  adminConductReportDecisionBodySchema,
  adminReportCaseDecisionBodySchema,
  adminReportDecisionBodySchema,
  adminReportDetailResponseSchema,
  adminReportEvidenceHeadersSchema,
  adminReportEvidenceParamsSchema,
  adminReportEvidenceQuerySchema,
  adminReportEvidenceResponseSchema,
  adminReportListQuerySchema,
  adminReportListResponseSchema,
  adminReportParamsSchema,
} from './admin-report.schema';

const rejectUnknownAdminReportDecisionFields = ({ body }: { body: unknown }) => {
  const schema =
    body !== null &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    'outcome' in body &&
    body.outcome === 'CONDUCT_REPORT_DISMISSED'
      ? adminConductReportDecisionBodySchema
      : adminReportCaseDecisionBodySchema;

  rejectUnknownFields(schema)({ body });
};

export const adminReportRoute = new Elysia({
  name: 'admin-report-route',
  prefix: `${API_V1_PREFIX}/admin`,
})
  .use(enabledAdminGuard)
  .get('/reports', listAdminReportsController, {
    query: adminReportListQuerySchema,
    response: responses(adminReportListResponseSchema, 400, 401, 403),
    detail: {
      tags: ['Admin Reports'],
      summary: 'List Report Cases and Conduct Reports for Admin review',
      description:
        'Lists a shared queue of Message-based Report Cases and Quest-based Conduct Reports. Supports exact kind, status, reported Member, and Quest filters. The default queue contains open reports and sorts newest first. Each item has a kind discriminator.',
      operationId: 'listAdminReports',
      security: betterAuthSecurity,
    },
  })
  .get('/reports/:reportId', getAdminReportController, {
    params: adminReportParamsSchema,
    response: responses(adminReportDetailResponseSchema, 400, 401, 403, 404),
    detail: {
      tags: ['Admin Reports'],
      summary: 'Get Report Case or Conduct Report detail for Admin review',
      description:
        'Returns a Report Case summary or Conduct Report detail with the Quest, Assignment, and Proof Submission record. Report Case Message content is available only through the case-scoped evidence route.',
      operationId: 'getAdminReport',
      security: betterAuthSecurity,
    },
  })
  .post('/reports/:reportId/decide', decideAdminReportController, {
    params: adminReportParamsSchema,
    headers: adminReportCommandHeadersSchema,
    body: adminReportDecisionBodySchema,
    transform: rejectUnknownAdminReportDecisionFields,
    response: responses(adminReportCommandResponseSchema, 400, 401, 403, 404, 409),
    detail: {
      tags: ['Admin Reports'],
      summary: 'Apply a Report Case or Conduct Report decision',
      description:
        'Applies an Admin decision to a Report Case or dismisses a pending Conduct Report. Commands require an action-specific reason code, current resource version, Idempotency-Key, and immutable Admin Action.',
      operationId: 'decideAdminReport',
      security: betterAuthSecurity,
    },
  })
  .get('/evidence/:evidenceRef', getAdminReportEvidenceController, {
    params: adminReportEvidenceParamsSchema,
    query: adminReportEvidenceQuerySchema,
    headers: adminReportEvidenceHeadersSchema,
    response: responses(adminReportEvidenceResponseSchema, 400, 401, 403, 404, 503),
    detail: {
      tags: ['Admin Reports'],
      summary: 'Read case-scoped Report evidence or Conduct Report Chat history',
      description:
        'Returns Report Case context or one bounded chronological page from a Conduct Report Conversation. Conduct Report evidence handles are scoped to their Report and permitted Conversation. Every page read is recorded as an Admin Action.',
      operationId: 'getAdminReportEvidence',
      security: betterAuthSecurity,
    },
  });
