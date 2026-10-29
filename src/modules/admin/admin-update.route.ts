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
      description: [
        'Opens a credentialed Server-Sent Events stream for an enabled Admin Session. Each `message` event has JSON data with only `type: RESOURCE_UPDATED`, a `subjectType` from QUEST, DISPUTE_CASE, REPORT_CASE, CONDUCT_REPORT, MEMBER, WALLET, PAYOUT, TOP_UP, or ADMIN_ACTIVITY_LOG, and the stable API `subjectId`. Events contain invalidation metadata only.',
        'A `DISPUTE_CASE` event refreshes the Dispute Case queue, counts, and matching open detail with `GET /api/v1/admin/disputes` and `GET /api/v1/admin/disputes/{disputeCaseId}`. A `QUEST` event identifies the Quest and refreshes `GET /api/v1/admin/quests`, its matching detail with `GET /api/v1/admin/quests/{questId}`, its financial audit trail with `GET /api/v1/admin/finance/quests/{questId}`, `GET /api/v1/admin/overview`, and open Admin search results. A `MEMBER` event identifies a Hirer or Worker when Quest history, status, or performance reads also change.',
        'A `WALLET` event refreshes the matching Wallet detail and list with `GET /api/v1/admin/wallets/{walletId}` and `GET /api/v1/admin/wallets`, its status history with `GET /api/v1/admin/wallets/{walletId}/status-history`, filtered ledger transactions with `GET /api/v1/admin/finance/ledger/transactions?walletId={walletId}`, and the finance overview with `GET /api/v1/admin/finance/overview`. To refresh the Member finance profile, call `GET /api/v1/admin/finance/members/{userId}`; its response has `data.wallet.id` and `data.member.userId`. When `data.wallet.id` matches the Wallet event `subjectId`, use `data.member.userId` as `{userId}`. This response includes Wallet balances and active Funding Reservations. Dispute Case resolution publishes Wallet IDs when it transfers funds. A Wallet change publishes separate `WALLET` and `MEMBER` events.',
        '`REPORT_CASE` and `CONDUCT_REPORT` events invalidate the reports queue, filters, status counts, and matching open detail with `GET /api/v1/admin/reports/{reportId}`; refresh list data with `GET /api/v1/admin/reports` and overview counters with `GET /api/v1/admin/overview`.',
        'A `MEMBER` event identifies the Member whose Admin detail (`GET /api/v1/admin/members/{id}` or `GET /api/v1/admin/members/{memberId}`), reviews, history, Profile Tags, Work Experience, Certificates, Penalty History, or finance profile changed. Refresh `GET /api/v1/admin/members`, `GET /api/v1/admin/members/{id}/penalty-history`, `GET /api/v1/admin/finance/members/{userId}`, `GET /api/v1/admin/overview`, open Admin search results, and open Quest reads that show this Member as Hirer, applicant, team member, Worker, or proof submitter. Also refresh open Member history reads when this Member appears as a related Hirer or Worker. Member Review reads include a Reviewer display ID but no stable Reviewer Member ID, so refresh all open `GET /api/v1/admin/members/{memberId}/reviews` reads after a `MEMBER` event.',
        'A `PAYOUT` event refreshes `GET /api/v1/admin/payouts`, its matching detail at `GET /api/v1/admin/payouts/{payoutId}`, its status history at `GET /api/v1/admin/payouts/{payoutId}/status-history`, the Member finance profile for the Member ID in the refreshed Payout, `GET /api/v1/admin/finance/ledger/transactions`, `GET /api/v1/admin/finance/overview`, and `GET /api/v1/admin/overview`.',
        'A `TOP_UP` event refreshes `GET /api/v1/admin/top-ups`, its matching detail at `GET /api/v1/admin/top-ups/{topUpId}`, its status history at `GET /api/v1/admin/top-ups/{topUpId}/status-history`, the Member finance profile for the Member ID in the refreshed Top-up, `GET /api/v1/admin/finance/ledger/transactions`, `GET /api/v1/admin/finance/overview`, and `GET /api/v1/admin/overview`.',
        'An `ADMIN_ACTIVITY_LOG` event identifies one new Admin Action; refresh `GET /api/v1/admin/activity-log` or its plural alias. Finance events include only their stable resource ID. Other resource types need a documented read mapping in their publishing slice. The stream sends keep-alive comments and does not replay missed events. After EventSource reconnects, refresh current Admin reads. The Server closes the stream when the Admin Session expires or the database update listener reconnects.',
      ].join(' '),
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
