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
  adminConductReportDismissDecisionBodySchema,
  adminConductReportUpholdDecisionBodySchema,
  adminReportCaseDecisionBodySchema,
  adminReportCaseDismissDecisionBodySchema,
  adminReportCaseHideDecisionBodySchema,
  adminReportCaseRestoreDecisionBodySchema,
  adminReportCommandHeadersSchema,
  adminReportCommandResponseSchema,
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
    body !== null && typeof body === 'object' && !Array.isArray(body) && 'outcome' in body
      ? body.outcome === 'CONDUCT_REPORT_DISMISSED'
        ? adminConductReportDismissDecisionBodySchema
        : body.outcome === 'CONDUCT_REPORT_UPHELD'
          ? adminConductReportUpholdDecisionBodySchema
          : body.outcome === 'REPORT_CASE_DISMISSED'
            ? adminReportCaseDismissDecisionBodySchema
            : body.outcome === 'REPORT_CASE_HIDDEN'
              ? adminReportCaseHideDecisionBodySchema
              : adminReportCaseRestoreDecisionBodySchema
      : adminReportCaseDismissDecisionBodySchema;

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
        'Lists the shared Report Case and Conduct Report queue. The default statusMode=OPEN_QUEUE ' +
        'includes Report Case pending/hidden and Conduct Report pending; FULL_HISTORY includes every ' +
        'status. A status filter selects one status. memberId filters the reported Member; ' +
        'submittedByMemberId filters a Reporter Entry or the Conduct Report filer. countsByStatus ' +
        'uses the same kind, Member, submitter, Quest, search, mode, and status filters. Message ' +
        'content and file links remain available only through case-scoped evidence reads.',
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
        'Returns Report Case Reporter Entries and Evidence References, or Conduct Report detail with its Quest, Assignment, Proof Submission, Member, and decision context. Message content and file links are available only through the case-scoped evidence route.',
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
        'REPORT_CASE_DISMISSED reasonCode is REPORT_NO_POLICY_VIOLATION, REPORT_INSUFFICIENT_EVIDENCE, or REPORT_CONTEXT_SUPPORTS_MESSAGE. REPORT_CASE_HIDDEN reasonCode is REPORT_HARASSMENT_CONFIRMED, REPORT_SPAM_CONFIRMED, REPORT_THREAT_CONFIRMED, REPORT_INAPPROPRIATE_CONTENT_CONFIRMED, or REPORT_OTHER_POLICY_VIOLATION_CONFIRMED. REPORT_CASE_RESTORED reasonCode is REPORT_MESSAGE_COMPLIES_WITH_POLICY, REPORT_CONTEXT_WAS_MISUNDERSTOOD, or REPORT_NEW_EVIDENCE_OVERTURNS_HIDE. Reporter Entry reasons are REPORT_ABUSIVE_OR_HARASSMENT, REPORT_SPAM, REPORT_INAPPROPRIATE_CONTENT, REPORT_DANGER_OR_THREAT, or REPORT_OTHER. CONDUCT_REPORT_DISMISSED and CONDUCT_REPORT_UPHELD require an Admin-selected decisionReasonCode from their outcome-specific catalogs; filed reasons CONDUCT_ABANDONED, CONDUCT_OUT_OF_SCOPE, or CONDUCT_NO_SHOW remain separate. Each decision can include an optional Admin-only decisionReasonText of up to 200 characters. Commands require a current resource version, Idempotency-Key, and immutable Admin Action.',
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
