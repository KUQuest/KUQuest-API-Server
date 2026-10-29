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
        'Opens a credentialed Server-Sent Events stream for an enabled Admin Session. Each `message` event has JSON data with `type: RESOURCE_UPDATED`, a `subjectType` from QUEST, DISPUTE_CASE, REPORT_CASE, CONDUCT_REPORT, MEMBER, WALLET, PAYOUT, TOP_UP, or ADMIN_ACTIVITY_LOG, and the stable API `subjectId`. Events contain invalidation metadata only. A DISPUTE_CASE event refreshes the Dispute Case queue, counts, and any matching open detail with `GET /api/v1/admin/disputes` and `GET /api/v1/admin/disputes/{disputeCaseId}`. A related QUEST event identifies that Quest by its `subjectId` and refreshes its Admin detail with `GET /api/v1/admin/quests/{questId}`, its financial audit trail with `GET /api/v1/admin/finance/quests/{questId}`, and overview counts with `GET /api/v1/admin/overview`. A WALLET event refreshes the matching Wallet detail and list with `GET /api/v1/admin/wallets/{walletId}` and `GET /api/v1/admin/wallets`; it may also refresh filtered ledger transactions with `GET /api/v1/admin/finance/ledger/transactions?walletId={walletId}` and the finance overview with `GET /api/v1/admin/finance/overview`. The Admin may refresh `GET /api/v1/admin/finance/members/{userId}` when an open response exposes `wallet.id` equal to the event `subjectId`; use the response value `member.userId` for `{userId}`. This response includes wallet balances and active Funding Reservations. Dispute Case resolution publishes Wallet IDs when it transfers funds. Conduct Report events refresh the reports queue and counts with `GET /api/v1/admin/reports`, the matching open detail with `GET /api/v1/admin/reports/{reportId}` when its ID equals `subjectId`, and overview counters with `GET /api/v1/admin/overview`. Other resource types need a documented read mapping in their publishing slice. The stream sends keep-alive comments and does not replay missed events. After EventSource reconnects, refresh current Admin reads. The Server closes the stream when the Admin Session expires or the database update listener reconnects.',
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
