import { enabledAdminGuard } from '@/modules/auth';
import { API_V1_PREFIX } from '@/shared/api-version';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';

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
  adminReportDecisionBodySchema,
  adminReportDetailResponseSchema,
  adminReportEvidenceHeadersSchema,
  adminReportEvidenceParamsSchema,
  adminReportEvidenceResponseSchema,
  adminReportListQuerySchema,
  adminReportListResponseSchema,
  adminReportParamsSchema,
} from './admin-report.schema';

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
      summary: 'List Report Cases for Trust and Safety review',
      description:
        'Lists Report Case queue pages with Reporter Entries and Evidence References, without unrelated Work Conversation content.',
      operationId: 'listAdminReports',
      security: betterAuthSecurity,
    },
  })
  .get('/reports/:reportId', getAdminReportController, {
    params: adminReportParamsSchema,
    response: responses(adminReportDetailResponseSchema, 400, 401, 403, 404),
    detail: {
      tags: ['Admin Reports'],
      summary: 'Get Report Case detail for Trust and Safety review',
      description:
        'Returns the Report Case, Reporter Entries, and Evidence References. Message content is available only through the case-scoped evidence route.',
      operationId: 'getAdminReport',
      security: betterAuthSecurity,
    },
  })
  .post('/reports/:reportId/decide', decideAdminReportController, {
    params: adminReportParamsSchema,
    headers: adminReportCommandHeadersSchema,
    body: adminReportDecisionBodySchema,
    response: responses(adminReportCommandResponseSchema, 400, 401, 403, 404, 409),
    detail: {
      tags: ['Admin Reports'],
      summary: 'Apply a Trust and Safety Report Case decision',
      description:
        'Dismisses, hides, or restores a Report Case with an Admin Action, a current resource version, and an immutable Moderation Decision.',
      operationId: 'decideAdminReport',
      security: betterAuthSecurity,
    },
  })
  .get('/evidence/:evidenceRef', getAdminReportEvidenceController, {
    params: adminReportEvidenceParamsSchema,
    headers: adminReportEvidenceHeadersSchema,
    response: responses(adminReportEvidenceResponseSchema, 400, 401, 403, 404, 503),
    detail: {
      tags: ['Admin Reports'],
      summary: 'Read case-scoped Report evidence',
      description:
        'Returns the reported Message and bounded surrounding Messages. Every access is recorded as an Admin Action and is not a general Work Conversation read.',
      operationId: 'getAdminReportEvidence',
      security: betterAuthSecurity,
    },
  });
