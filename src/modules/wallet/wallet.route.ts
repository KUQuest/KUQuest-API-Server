import { authGuard } from '@/modules/auth';
import { API_V1_PREFIX } from '@/shared/api-version';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';

import { Elysia } from 'elysia';

import {
  convertEarningsController,
  getOwnWallet,
  getWalletActivitiesController,
} from './wallet.controller';
import {
  earningsConversionCreateSchema,
  earningsConversionHeadersSchema,
  earningsConversionResponseSchema,
  walletActivitiesQuerySchema,
  walletActivitiesResponseSchema,
  walletResponseSchema,
} from './wallet.schema';

export const walletRoute = new Elysia({
  name: 'wallet-route',
  prefix: `${API_V1_PREFIX}/wallet`,
})
  .use(authGuard)
  .get('', getOwnWallet, {
    response: responses(walletResponseSchema, 401, 404, 409),
    detail: {
      tags: ['Wallet'],
      summary: 'Get own Wallet',
      description: 'Returns the four Wallet compartments for the authenticated Student.',
      operationId: 'getOwnWallet',
      security: betterAuthSecurity,
    },
  })
  .post('/earnings-conversions', convertEarningsController, {
    body: earningsConversionCreateSchema,
    headers: earningsConversionHeadersSchema,
    response: responses(earningsConversionResponseSchema, 400, 401, 404, 409),
    detail: {
      tags: ['Wallet'],
      summary: 'Convert Earnings to Spending',
      description: 'Converts an integer satang amount from Earnings Balance to Spending Balance fee-free and irreversibly.',
      operationId: 'convertEarnings',
      security: betterAuthSecurity,
    },
  })
  .get('/activities', getWalletActivitiesController, {
    query: walletActivitiesQuerySchema,
    response: responses(walletActivitiesResponseSchema, 400, 401, 409),
    detail: {
      tags: ['Wallet'],
      summary: 'List own Wallet activities',
      description: 'Returns the ledger-backed activities for the authenticated Student wallet in reverse chronological order.',
      operationId: 'listWalletActivities',
      security: betterAuthSecurity,
    },
  });
