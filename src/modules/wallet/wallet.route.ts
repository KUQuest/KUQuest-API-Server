import { authGuard, getTrustedOrigins, memberBanGuard } from '@/modules/auth';
import { API_V1_PREFIX } from '@/shared/api-version';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';

import { Elysia } from 'elysia';

import { logSocket } from '@/shared/request-log';
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
import {
  ensureWalletUpdateListener,
  stopWalletUpdateListener,
  subscribeToWalletUpdates,
} from './wallet-update.delivery';

const socketCleanups = new WeakMap<object, () => void>();
const trustedOrigins = getTrustedOrigins(true);

export const walletRoute = new Elysia({
  name: 'wallet-route',
  prefix: `${API_V1_PREFIX}/wallet`,
})
  .use(authGuard)
  .use(memberBanGuard)
  .ws('/events', {
    async open(ws) {
      const { user, session } = ws.data.session;
      logSocket(ws, 'open');
      const origin = ws.data.request.headers.get('origin');
      if (origin !== null && !trustedOrigins.includes(origin)) {
        ws.close(4403, 'Origin not allowed');
        return;
      }
      try {
        await ensureWalletUpdateListener();
        const unsubscribe = subscribeToWalletUpdates(user.id, session.id, session.expiresAt, {
          send: (message) => {
            ws.send(message);
            logSocket(ws, 'send', { type: 'WALLET_UPDATE' });
          },
          close: (code, reason) => ws.close(code, reason),
        });
        socketCleanups.set(ws, unsubscribe);
        ws.send(JSON.stringify({ type: 'SUBSCRIBED', version: 1 }));
        logSocket(ws, 'subscribed');
      } catch {
        ws.close(1013, 'Wallet update service unavailable');
      }
    },
    message(ws) {
      logSocket(ws, 'rejected', { type: 'READ_ONLY_COMMAND', code: 1008 });
      ws.close(1008, 'Wallet update stream is read-only');
    },
    close(ws, code) {
      socketCleanups.get(ws)?.();
      socketCleanups.delete(ws);
      logSocket(ws, 'close', { code });
    },
    detail: {
      tags: ['Wallet'],
      summary: 'Subscribe to Wallet and Top-up updates',
      description:
        'Subscribes the authenticated Member to Wallet activity and Top-up status invalidations. Read Wallet balances, activities, and Top-up status from REST after each update.',
      operationId: 'subscribeWalletUpdates',
    },
  })
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
      description:
        'Converts an integer satang amount from Earnings Balance to Spending Balance fee-free and irreversibly.',
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
      description:
        'Returns the ledger-backed activities for the authenticated Student wallet in reverse chronological order.',
      operationId: 'listWalletActivities',
      security: betterAuthSecurity,
    },
  })
  .onStop(() => stopWalletUpdateListener());
