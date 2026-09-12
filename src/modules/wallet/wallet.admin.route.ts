import { enabledAdminGuard } from '@/modules/auth';
import { API_V1_PREFIX } from '@/shared/api-version';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';

import { Elysia } from 'elysia';

import {
  changeWalletStatusAdminController,
  getAdminWalletDetailController,
  listAdminWalletsController,
  listWalletStatusHistoryAdminController,
  rebuildWalletProjectionAdminController,
  verifyWalletProjectionAdminController,
} from './wallet.admin.controller';
import {
  adminWalletFullDetailResponseSchema,
  adminWalletListQuerySchema,
  adminWalletListResponseSchema,
  adminWalletParamsSchema,
  adminWalletResponseSchema,
  adminWalletStatusChangeHeadersSchema,
  adminWalletStatusChangeSchema,
  adminWalletStatusHistoryResponseSchema,
  adminWalletVerificationResponseSchema,
} from './wallet.admin.schema';

export const adminWalletRoute = new Elysia({
  name: 'admin-wallet-route',
  prefix: `${API_V1_PREFIX}/admin/wallets`,
})
  .use(enabledAdminGuard)
  .get('', listAdminWalletsController, {
    query: adminWalletListQuerySchema,
    response: responses(adminWalletListResponseSchema, 400, 401, 403),
    detail: {
      tags: ['Admin Wallets'],
      summary: 'List and filter all Member Wallets',
      description: 'Returns all Member Wallets with both Spending and Earnings balances in a single request, with search and status filters.',
      operationId: 'listAdminWallets',
      security: betterAuthSecurity,
    },
  })
  .get('/:walletId', getAdminWalletDetailController, {
    params: adminWalletParamsSchema,
    response: responses(adminWalletFullDetailResponseSchema, 400, 401, 403, 404),
    detail: {
      tags: ['Admin Wallets'],
      summary: 'Get Member Wallet Details',
      description: 'Returns full wallet balance compartments (Spending, Earnings, Holds) and ledger reconciliation status.',
      operationId: 'getAdminWalletDetail',
      security: betterAuthSecurity,
    },
  })
  .get('/:walletId/status-history', listWalletStatusHistoryAdminController, {
    params: adminWalletParamsSchema,
    response: responses(adminWalletStatusHistoryResponseSchema, 400, 401, 403, 404, 409),
    detail: {
      tags: ['Admin Wallets'],
      summary: 'List Wallet status history for Admin review',
      description: 'Returns the chronological status changes recorded for the specified Wallet.',
      operationId: 'listAdminWalletStatusHistory',
      security: betterAuthSecurity,
    },
  })
  .post('/:walletId/status', changeWalletStatusAdminController, {
    params: adminWalletParamsSchema,
    headers: adminWalletStatusChangeHeadersSchema,
    body: adminWalletStatusChangeSchema,
    response: responses(adminWalletResponseSchema, 400, 401, 403, 404, 409),
    detail: {
      tags: ['Admin Wallets'],
      summary: 'Change Wallet status',
      description: 'Changes Wallet status to ACTIVE, FROZEN, SUSPENDED, or CLOSED with mandatory reason and Idempotency-Key.',
      operationId: 'changeAdminWalletStatus',
      security: betterAuthSecurity,
    },
  })
  .get('/:walletId/verification', verifyWalletProjectionAdminController, {
    params: adminWalletParamsSchema,
    response: responses(adminWalletVerificationResponseSchema, 400, 401, 403, 404, 409),
    detail: {
      tags: ['Admin Wallets'],
      summary: 'Verify Wallet projection against Ledger source of truth',
      description: 'Compares the stored Wallet balances and activity projection against the sealed double-entry Ledger.',
      operationId: 'verifyAdminWalletProjection',
      security: betterAuthSecurity,
    },
  })
  .post('/:walletId/rebuild-projection', rebuildWalletProjectionAdminController, {
    params: adminWalletParamsSchema,
    response: responses(adminWalletResponseSchema, 400, 401, 403, 404, 409),
    detail: {
      tags: ['Admin Wallets'],
      summary: 'Rebuild Wallet projection from Ledger source of truth',
      description: 'Reconstructs the Wallet balances and activities from the sealed double-entry Ledger source of truth.',
      operationId: 'rebuildAdminWalletProjection',
      security: betterAuthSecurity,
    },
  });
