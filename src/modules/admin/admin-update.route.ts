import { enabledAdminGuard } from '@/modules/auth';
import { apiErrorSchema, betterAuthAdminSecurity } from '@/shared/api-response.schema';
import { API_V1_PREFIX } from '@/shared/api-version';

import { Elysia } from 'elysia';

import { subscribeAdminUpdatesController } from './admin-update.controller';

export const adminUpdateRoute = new Elysia({
  name: 'admin-update-route',
  prefix: `${API_V1_PREFIX}/admin`,
})
  .use(enabledAdminGuard)
  .get('/events', subscribeAdminUpdatesController, {
    detail: {
      tags: ['Admin Updates'],
      summary: 'Subscribe to Admin resource invalidations',
      description:
        'Opens a credentialed Server-Sent Events stream for an enabled Admin Session. Each `message` event has JSON data with `type: RESOURCE_UPDATED`, a `subjectType` from QUEST, DISPUTE_CASE, REPORT_CASE, CONDUCT_REPORT, MEMBER, WALLET, PAYOUT, TOP_UP, or ADMIN_ACTIVITY_LOG, and the stable API `subjectId`. Events contain invalidation metadata only. For `QUEST`, refresh `GET /api/v1/admin/quests`, the matching `GET /api/v1/admin/quests/{questId}`, `GET /api/v1/admin/overview`, and open Admin search results. A related `MEMBER` event identifies a Hirer or Worker when Quest history, status, or performance reads also change. For `MEMBER`, refresh `GET /api/v1/admin/members`, the matching `GET /api/v1/admin/members/{memberId}` and its reviews, history, Profile Tags, Work Experience, Certificates, or Penalty History sub-reads, `GET /api/v1/admin/overview`, any open Admin search results, and open Quest reads that show this Member as Hirer, applicant, team member, Worker, or proof submitter. Also refresh open Member history reads when this Member appears as a related Hirer or Worker. Member Review reads include a Reviewer display ID but no stable Reviewer Member ID, so refresh all open `GET /api/v1/admin/members/{memberId}/reviews` reads after a `MEMBER` event. For `CONDUCT_REPORT`, refresh `GET /api/v1/admin/reports`, its matching open detail when `subjectId` is a report ID, and `GET /api/v1/admin/overview`. Other resource types use the read mappings in their publishing slices. The stream sends keep-alive comments and does not replay missed events. After EventSource reconnects, refresh current Admin reads. The Server closes the stream when the Admin Session expires or the database update listener reconnects.',
      operationId: 'subscribeAdminUpdates',
      security: betterAuthAdminSecurity,
      responses: {
        '200': {
          description: 'An SSE stream. Each message contains one JSON resource invalidation event.',
          content: {
            'text/event-stream': {
              schema: { type: 'string' },
              example:
                'data: {"type":"RESOURCE_UPDATED","subjectType":"CONDUCT_REPORT","subjectId":"00000000-0000-4000-8000-000000000000"}\n\n',
            },
          },
        },
        '401': {
          description: 'No valid Admin Session was provided.',
          content: {
            'application/json': {
              schema: apiErrorSchema,
              example: {
                success: false,
                error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
              },
            },
          },
        },
        '403': {
          description: 'The caller is a Member, the Admin is disabled, or Origin is not allowed.',
          content: {
            'application/json': {
              schema: apiErrorSchema,
              examples: {
                member: {
                  value: {
                    success: false,
                    error: { code: 'FORBIDDEN', message: 'Forbidden' },
                  },
                },
                disabledAdmin: {
                  value: {
                    success: false,
                    error: { code: 'ADMIN_DISABLED', message: 'Admin account is disabled' },
                  },
                },
                origin: {
                  value: {
                    success: false,
                    error: { code: 'FORBIDDEN', message: 'Origin not allowed' },
                  },
                },
              },
            },
          },
        },
        '503': {
          description: 'The database event listener is unavailable.',
          content: {
            'application/json': {
              schema: apiErrorSchema,
              example: {
                success: false,
                error: {
                  code: 'ADMIN_UPDATES_UNAVAILABLE',
                  message: 'Admin updates are unavailable',
                },
              },
            },
          },
        },
      },
    },
  });
