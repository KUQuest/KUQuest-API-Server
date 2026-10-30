import type { AuthedContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';

import type {
  QuestV2ConductReportCreateInput,
  QuestV2ConductReportParams,
} from './quest-conduct-report-v2.schema';
import {
  createQuestV2ConductReport,
  getQuestV2ConductReportView,
  type QuestV2ConductReportOutcome,
  type QuestV2ConductReportRow,
} from './quest-conduct-report-v2.service';
import {
  mapQuestCommandOutcome,
  requireQuestCommandId,
} from '../../shared/command/quest-command.controller';

const serializeReport = (report: QuestV2ConductReportRow) => ({
  ...report,
  createdAt: report.createdAt.toISOString(),
});

const mapConductReportError = (
  set: AuthedContext['set'],
  result: Exclude<QuestV2ConductReportOutcome, QuestV2ConductReportRow>
) => {
  if (result.outcome === 'not-found') {
    set.status = 404;
    return apiError('QUEST_NOT_FOUND', 'Quest not found');
  }
  if (result.outcome === 'not-allowed') {
    set.status = 403;
    return apiError(
      'CONDUCT_REPORT_NOT_ALLOWED',
      'You cannot file this Conduct Report against this Member on this Quest'
    );
  }
  if (result.outcome === 'window-closed') {
    set.status = 409;
    return apiError(
      'CONDUCT_REPORT_WINDOW_CLOSED',
      'Conduct Reports can be filed from QUEST_ASSIGNED until 1 day after the Quest becomes Terminal'
    );
  }
  if (result.outcome === 'already-reported') {
    set.status = 409;
    return apiError(
      'CONDUCT_REPORT_ALREADY_EXISTS',
      'A Conduct Report already exists for this Member on this Quest'
    );
  }
  if (result.outcome === 'invalid-detail') {
    set.status = 400;
    return apiError('INVALID_DETAIL', 'detail must be non-blank and at most 1,000 characters');
  }
  return mapQuestCommandOutcome(set, result.outcome);
};

export const createQuestV2ConductReportController = async ({
  body,
  params,
  request,
  session,
  set,
}: AuthedContext & {
  body: QuestV2ConductReportCreateInput;
  params: QuestV2ConductReportParams;
}) => {
  const commandId = requireQuestCommandId(request, set);
  if (typeof commandId !== 'string') return commandId;

  const result = await createQuestV2ConductReport(session.user.id, params.questId, body, commandId);
  if ('outcome' in result) return mapConductReportError(set, result);
  return apiSuccess(serializeReport(result));
};

export const getQuestV2ConductReportsController = async ({
  params,
  session,
  set,
}: AuthedContext & { params: QuestV2ConductReportParams }) => {
  const result = await getQuestV2ConductReportView(session.user.id, params.questId);
  if ('outcome' in result) {
    set.status = 404;
    return apiError('QUEST_NOT_FOUND', 'Quest not found');
  }
  return apiSuccess({
    windowEndsAt: result.windowEndsAt?.toISOString() ?? null,
    reportable: result.reportable,
    items: result.items.map(serializeReport),
  });
};
