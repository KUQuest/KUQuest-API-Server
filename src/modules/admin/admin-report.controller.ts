import type { AdminContext } from '@/modules/auth';
import { apiError, apiSuccess, type ApiResponse } from '@/shared/api-response';
import { CursorInputError, decodeCursor, encodeCursor, parsePageLimit } from '@/shared/cursor';
import { FileLinkUnavailableError } from '@/shared/object-storage';
import { readResourceVersion } from '@/shared/resource-version';

import type {
  AdminReportCommandData,
  AdminReportDecisionBody,
  AdminReportDetailData,
  AdminReportEvidenceData,
  AdminReportEvidenceParams,
  AdminReportListData,
  AdminReportListQuery,
  AdminReportParams,
} from './admin-report.schema';
import {
  AdminReportCaseError,
  decideAdminReportCase,
  getAdminReport,
  getAdminReportEvidence,
  listAdminReports,
} from './admin-report.service';
import { AdminActionError } from './admin-action.policy';

const mapAdminReportError = (set: AdminContext['set'], error: unknown): ApiResponse => {
  if (error instanceof CursorInputError) {
    set.status = 400;
    return apiError(error.code, error.message);
  }
  if (error instanceof AdminReportCaseError) {
    if (error.code === 'REPORT_CASE_NOT_FOUND' || error.code === 'REPORT_EVIDENCE_NOT_FOUND') {
      set.status = 404;
      return apiError('REPORT_NOT_FOUND', 'Report resource was not found.');
    }
    set.status = 409;
    return apiError(error.code, error.message);
  }
  if (error instanceof AdminActionError) {
    if (error.code === 'ADMIN_ACTION_ADMIN_NOT_FOUND') set.status = 403;
    else if (
      error.code === 'ADMIN_ACTION_INVALID_VERSION' ||
      error.code === 'ADMIN_ACTION_REASON_REQUIRED' ||
      error.code === 'ADMIN_ACTION_INVALID_REASON_CODE'
    )
      set.status = 400;
    else if (
      error.code === 'ADMIN_ACTION_KEY_REUSED' ||
      error.code === 'ADMIN_ACTION_CONFLICT' ||
      error.code === 'ADMIN_ACTION_WRITE_FAILED'
    )
      set.status = 409;
    else set.status = 400;
    return apiError(error.code, error.message);
  }
  if (error instanceof FileLinkUnavailableError) {
    set.status = 503;
    return apiError('REPORT_EVIDENCE_UNAVAILABLE', 'Report evidence links are unavailable.');
  }
  throw error;
};

export const listAdminReportsController = async ({
  query,
  set,
}: AdminContext & { query: AdminReportListQuery }): Promise<ApiResponse<AdminReportListData>> => {
  try {
    const result = await listAdminReports({
      kind: query.kind,
      status: query.status,
      memberId: query.memberId,
      questId: query.questId,
      limit: parsePageLimit(query.limit),
      cursor: decodeCursor(query.cursor),
      sort: query.sort,
    });
    return apiSuccess({
      items: result.items,
      nextCursor: result.nextCursor ? encodeCursor(result.nextCursor) : null,
    });
  } catch (error) {
    return mapAdminReportError(set, error) as ApiResponse<AdminReportListData>;
  }
};

export const getAdminReportController = async ({
  params,
  set,
}: AdminContext & { params: AdminReportParams }): Promise<ApiResponse<AdminReportDetailData>> => {
  try {
    return apiSuccess(await getAdminReport(params.reportId)) as ApiResponse<AdminReportDetailData>;
  } catch (error) {
    return mapAdminReportError(set, error) as ApiResponse<AdminReportDetailData>;
  }
};

export const decideAdminReportController = async ({
  body,
  params,
  request,
  admin,
  set,
}: AdminContext & {
  body: AdminReportDecisionBody;
  params: AdminReportParams;
  request: Request;
}): Promise<ApiResponse<AdminReportCommandData>> => {
  const revision = readResourceVersion(request);
  if (revision.invalid || revision.value === undefined) {
    set.status = 400;
    return apiError('ADMIN_ACTION_INVALID_VERSION', 'A current Report Case version is required.');
  }

  try {
    const result = await decideAdminReportCase({
      adminId: admin.id,
      reportId: params.reportId,
      expectedVersion: revision.value,
      requestKey: request.headers.get('idempotency-key') ?? '',
      reasonCode: body.reasonCode,
      outcome: body.outcome,
    });
    if (result.resourceVersion === null) {
      set.status = 500;
      return apiError(
        'ADMIN_ACTION_INVALID_RESULT',
        'Admin Action did not return a Report Case version.'
      );
    }
    return apiSuccess({
      resourceSummary: result.resourceSummary,
      resourceVersion: result.resourceVersion,
      adminActionId: result.adminActionId,
    });
  } catch (error) {
    return mapAdminReportError(set, error) as ApiResponse<AdminReportCommandData>;
  }
};

export const getAdminReportEvidenceController = async ({
  params,
  request,
  admin,
  set,
}: AdminContext & {
  params: AdminReportEvidenceParams;
  request: Request;
}): Promise<ApiResponse<AdminReportEvidenceData>> => {
  try {
    return apiSuccess(
      await getAdminReportEvidence(
        admin.id,
        params.evidenceRef,
        request.headers.get('idempotency-key') ?? ''
      )
    );
  } catch (error) {
    return mapAdminReportError(set, error) as ApiResponse<AdminReportEvidenceData>;
  }
};
