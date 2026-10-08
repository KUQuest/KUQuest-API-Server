import { authGuard, memberBanGuard } from '@/modules/auth';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { API_V2_PREFIX } from '@/shared/api-version';
import { rejectUnknownFields } from '@/shared/reject-unknown-fields';

import { Elysia } from 'elysia';

import {
  createQuestV2ConductReportController,
  getQuestV2ConductReportsController,
} from './quest-conduct-report-v2.controller';
import {
  questV2ConductReportCreateSchema,
  questV2ConductReportHeadersSchema,
  questV2ConductReportListResponseSchema,
  questV2ConductReportParamsSchema,
  questV2ConductReportResponseSchema,
} from './quest-conduct-report-v2.schema';

export const questConductReportV2Route = new Elysia({
  name: 'quest-conduct-report-v2-route',
  prefix: `${API_V2_PREFIX}/quests`,
})
  .use(authGuard)
  .use(memberBanGuard)
  .get('/:questId/conduct-reports', getQuestV2ConductReportsController, {
    params: questV2ConductReportParamsSchema,
    response: responses(questV2ConductReportListResponseSchema, 401, 404, 500),
    detail: {
      tags: ['Quest Conduct Reports v2'],
      summary: 'Read the caller’s Conduct Report options and filed reports',
      description:
        'Returns `reportable`, the Conduct Reports the caller can file now, and `items`, the caller’s own Conduct Reports on the Quest with their status. The caller must be the Hirer or a Worker with an Assignment. A Hirer can report a Worker with CONDUCT_ABANDONED after `dueAt` when the Worker sent no Proof Submission and made no proof-free confirmation; on GROUP + CANDIDATE only the selected Team Leader can be reported. A Worker can report the Hirer with CONDUCT_OUT_OF_SCOPE, and on GROUP + FIRST_COME_FIRST_SERVED another Worker who delivered nothing with CONDUCT_NO_SHOW. The window opens at QUEST_ASSIGNED and closes 1 day after the Quest becomes Terminal (`windowEndsAt`). One Conduct Report per reported Member per Quest.',
      operationId: 'getQuestConductReportsV2',
      security: betterAuthSecurity,
    },
  })
  .post('/:questId/conduct-reports', createQuestV2ConductReportController, {
    params: questV2ConductReportParamsSchema,
    body: questV2ConductReportCreateSchema,
    headers: questV2ConductReportHeadersSchema,
    transform: rejectUnknownFields(questV2ConductReportCreateSchema),
    response: responses(questV2ConductReportResponseSchema, 400, 401, 403, 404, 409, 500, 503),
    detail: {
      tags: ['Quest Conduct Reports v2'],
      summary: 'File a Conduct Report',
      description:
        'Files one CONDUCT_REPORT_PENDING Conduct Report for Admin review. The pair must be listed in `reportable` of the GET. Filing moves no money, changes no Quest or Assignment state, and sends no notification. The reported Member never learns the filer. A matching Idempotency-Key replays the original result.',
      operationId: 'createQuestConductReportV2',
      security: betterAuthSecurity,
    },
  });
