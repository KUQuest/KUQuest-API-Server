import { authGuard } from '@/modules/auth';
import { API_V1_PREFIX } from '@/shared/api-version';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';

import { Elysia } from 'elysia';

import { getOwnWallet } from './wallet.controller';
import { walletResponseSchema } from './wallet.schema';

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
  });
