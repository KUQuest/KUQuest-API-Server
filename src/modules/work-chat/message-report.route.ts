import { authGuard, memberBanGuard } from '@/modules/auth';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { API_V1_PREFIX } from '@/shared/api-version';
import { rejectUnknownFields } from '@/shared/reject-unknown-fields';

import { Elysia } from 'elysia';

import {
  getOwnMessageReportController,
  listOwnMessageReportsController,
  submitMessageReportController,
} from './message-report.controller';
import {
  messageReportListQuerySchema,
  messageReportListResponseSchema,
  messageReportParamsSchema,
  messageReportResponseSchema,
  submitMessageReportSchema,
} from './message-report.schema';

export const messageReportRoute = new Elysia({
  name: 'message-report-route',
  prefix: `${API_V1_PREFIX}/chat/reports`,
})
  .use(authGuard)
  .use(memberBanGuard)
  .post('', submitMessageReportController, {
    body: submitMessageReportSchema,
    transform: rejectUnknownFields(submitMessageReportSchema),
    response: responses(messageReportResponseSchema, 400, 401, 404),
    detail: {
      tags: ['Message Reports'],
      summary: 'Report a visible Message',
      description:
        'Creates or replays the authenticated Member’s Reporter Entry for a visible Message.',
      operationId: 'submitMessageReport',
      security: betterAuthSecurity,
    },
  })
  .get('', listOwnMessageReportsController, {
    query: messageReportListQuerySchema,
    response: responses(messageReportListResponseSchema, 400, 401),
    detail: {
      tags: ['Message Reports'],
      summary: 'List own Message Reports',
      description: 'Lists only the authenticated Member’s Reporter Entries and case statuses.',
      operationId: 'listOwnMessageReports',
      security: betterAuthSecurity,
    },
  })
  .get('/:reporterEntryId', getOwnMessageReportController, {
    params: messageReportParamsSchema,
    response: responses(messageReportResponseSchema, 400, 401, 404),
    detail: {
      tags: ['Message Reports'],
      summary: 'Get own Message Report status',
      description: 'Returns one Reporter Entry owned by the authenticated Member.',
      operationId: 'getOwnMessageReport',
      security: betterAuthSecurity,
    },
  });
