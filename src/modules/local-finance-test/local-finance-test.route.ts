import { authGuard, type AuthenticatedSession } from '@/modules/auth';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';

import { Elysia } from 'elysia';

import {
  createLocalTestPayment,
  createLocalTestTransfer,
  getLocalTestWallet,
  isConfiguredLocalFinanceTestUser,
  localFinanceTestIsEnabled,
} from './local-finance-test.controller';
import {
  localTestPaymentBodySchema,
  localTestPaymentResponseSchema,
  localTestWalletResponseSchema,
  localTestTransferBodySchema,
  localTestTransferResponseSchema,
} from './local-finance-test.schema';

export const localFinanceTestRoute = new Elysia({
  name: 'local-finance-test-route',
  prefix: '/api/local/test',
})
  .use(authGuard)
  .guard({
    beforeHandle: (context) => {
      const session = (context as typeof context & { session?: AuthenticatedSession }).session;
      if (!session || !localFinanceTestIsEnabled || !isConfiguredLocalFinanceTestUser(session.user.email)) {
        return context.status(404);
      }
      return undefined;
    },
  }, (guarded) => guarded
    .get('/wallet', getLocalTestWallet, {
      response: responses(localTestWalletResponseSchema, 401, 404, 409),
      detail: {
        tags: ['Local finance tests'],
        summary: 'Read the local test Member Wallet',
        description: 'Local-only test route. Returns the four Wallet compartments for the configured Student test user.',
        operationId: 'getLocalFinanceTestWallet',
        security: betterAuthSecurity,
      },
    })
    .post('/payment', createLocalTestPayment, {
      body: localTestPaymentBodySchema,
      response: responses(localTestPaymentResponseSchema, 401, 404, 409, 502),
      detail: {
        tags: ['Local finance tests'],
        summary: 'Create a local Test Mode Payment',
        description: 'Local-only test route. Creates a real Xendit Test Mode Payment Request for the configured Student test user.',
        operationId: 'createLocalFinanceTestPayment',
        security: betterAuthSecurity,
      },
    })
    .post('/transfer', createLocalTestTransfer, {
      body: localTestTransferBodySchema,
      response: responses(localTestTransferResponseSchema, 401, 404, 409, 502),
      detail: {
        tags: ['Local finance tests'],
        summary: 'Transfer local test funds between Wallets',
        description: 'Local-only test route. Exercises Funding Reservation, balanced Ledger settlement, and Wallet projections between two test Members.',
        operationId: 'createLocalFinanceTestTransfer',
        security: betterAuthSecurity,
      },
    }));
