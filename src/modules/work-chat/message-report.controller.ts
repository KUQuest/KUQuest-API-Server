import type { AuthedContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';
import { CursorInputError, decodeCursor, encodeCursor, parsePageLimit } from '@/shared/cursor';

import type { Static } from 'elysia';

import type {
  messageReportListQuerySchema,
  messageReportParamsSchema,
  submitMessageReportSchema,
} from './message-report.schema';
import {
  getOwnMessageReport,
  listOwnMessageReports,
  MessageReportServiceError,
  submitMessageReport,
} from './message-report.service';

type SubmitMessageReportInput = Static<typeof submitMessageReportSchema>;
type MessageReportListQuery = Static<typeof messageReportListQuerySchema>;
type MessageReportParams = Static<typeof messageReportParamsSchema>;

const serializeReport = (report: Awaited<ReturnType<typeof submitMessageReport>>) => ({
  ...report,
  createdAt: report.createdAt.toISOString(),
  updatedAt: report.updatedAt.toISOString(),
});

const mapMessageReportError = (set: AuthedContext['set'], error: unknown) => {
  if (error instanceof CursorInputError) {
    set.status = 400;
    return apiError(error.code, error.message);
  }
  if (!(error instanceof MessageReportServiceError)) throw error;
  set.status = 404;
  return apiError(error.code, error.message);
};

export const submitMessageReportController = async ({
  body,
  session,
  set,
}: AuthedContext & { body: SubmitMessageReportInput }): Promise<ApiResponse> => {
  try {
    const report = await submitMessageReport(session.user.id, body);
    return apiSuccess({ reporterEntry: serializeReport(report) });
  } catch (error) {
    return mapMessageReportError(set, error);
  }
};

export const listOwnMessageReportsController = async ({
  query,
  session,
  set,
}: AuthedContext & { query: MessageReportListQuery }): Promise<ApiResponse> => {
  try {
    const result = await listOwnMessageReports(session.user.id, {
      limit: parsePageLimit(query.limit),
      cursor: decodeCursor(query.cursor),
    });
    return apiSuccess({
      items: result.items.map(serializeReport),
      nextCursor: result.nextCursor ? encodeCursor(result.nextCursor) : null,
    });
  } catch (error) {
    return mapMessageReportError(set, error);
  }
};

export const getOwnMessageReportController = async ({
  params,
  session,
  set,
}: AuthedContext & { params: MessageReportParams }): Promise<ApiResponse> => {
  try {
    const report = await getOwnMessageReport(session.user.id, params.reporterEntryId);
    return apiSuccess({ reporterEntry: serializeReport(report) });
  } catch (error) {
    return mapMessageReportError(set, error);
  }
};
