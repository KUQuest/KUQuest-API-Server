import { enabledAdminGuard } from '@/modules/auth';
import { API_V1_PREFIX } from '@/shared/api-version';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';

import { Elysia } from 'elysia';

import {
  getAdminFinanceOverviewController,
  getAdminMemberFinanceProfileController,
  getAdminQuestFinanceController,
  getCurrentMoneyPolicyController,
  listAdminLedgerTransactionsController,
  listMoneyPolicyRevisionsController,
} from './admin-finance.controller';
import {
  adminFinanceOverviewResponseSchema,
  adminLedgerTransactionsQuerySchema,
  adminLedgerTransactionsResponseSchema,
  adminMemberFinanceParamsSchema,
  adminMemberFinanceResponseSchema,
  adminMoneyPolicyCurrentResponseSchema,
  adminMoneyPolicyListResponseSchema,
  adminQuestFinanceParamsSchema,
  adminQuestFinanceResponseSchema,
} from './admin-finance.schema';

export const adminFinanceRoute = new Elysia({
  name: 'admin-finance-route',
  prefix: `${API_V1_PREFIX}/admin/finance`,
})
  .use(enabledAdminGuard)
  .get('/quests/:questId', getAdminQuestFinanceController, {
    params: adminQuestFinanceParamsSchema,
    response: responses(adminQuestFinanceResponseSchema, 400, 401, 403, 404),
    detail: {
      tags: ['Admin Finance'],
      summary: 'Get Quest Financial Audit Trail and Ledger Postings',
      description: 'Returns the complete money flow (A -> B) and underlying double-entry ledger transactions for one Quest.',
      operationId: 'getAdminQuestFinance',
      security: betterAuthSecurity,
    },
  })
  .get('/ledger/transactions', listAdminLedgerTransactionsController, {
    query: adminLedgerTransactionsQuerySchema,
    response: responses(adminLedgerTransactionsResponseSchema, 400, 401, 403),
    detail: {
      tags: ['Admin Finance'],
      summary: 'List and Filter Double-Entry Ledger Transactions',
      description: 'Returns paginated ledger transactions with zero-sum balanced verification, filtering by event type, user, or date.',
      operationId: 'listAdminLedgerTransactions',
      security: betterAuthSecurity,
    },
  })
  .get('/overview', getAdminFinanceOverviewController, {
    response: responses(adminFinanceOverviewResponseSchema, 400, 401, 403),
    detail: {
      tags: ['Admin Finance'],
      summary: 'Get Platform Financial Overview and Subledger Balance Sheet',
      description: 'Returns total platform revenue, escrow in transit, circulating member balances, lifetime volume, and subledger zero-sum integrity.',
      operationId: 'getAdminFinanceOverview',
      security: betterAuthSecurity,
    },
  })
  .get('/members/:userId', getAdminMemberFinanceProfileController, {
    params: adminMemberFinanceParamsSchema,
    response: responses(adminMemberFinanceResponseSchema, 400, 401, 403, 404),
    detail: {
      tags: ['Admin Finance'],
      summary: 'Get Member Financial Profile and Wallet Audit',
      description: 'Returns a member wallet balances, projection reconciliation status, lifetime financial statistics, and active reservations.',
      operationId: 'getAdminMemberFinanceProfile',
      security: betterAuthSecurity,
    },
  })
  .get('/policies/current', getCurrentMoneyPolicyController, {
    response: responses(adminMoneyPolicyCurrentResponseSchema, 400, 401, 403),
    detail: {
      tags: ['Admin Finance'],
      summary: 'Get Current Effective Money Policy',
      description: 'Returns the active platform fee, limits, and quote settings for Admin UI policies view.',
      operationId: 'getCurrentMoneyPolicy',
      security: betterAuthSecurity,
    },
  })
  .get('/policies', listMoneyPolicyRevisionsController, {
    response: responses(adminMoneyPolicyListResponseSchema, 400, 401, 403),
    detail: {
      tags: ['Admin Finance'],
      summary: 'List Money Policy Revisions',
      description: 'Returns the revision history of Money Policies for Admin audit.',
      operationId: 'listMoneyPolicyRevisions',
      security: betterAuthSecurity,
    },
  });
