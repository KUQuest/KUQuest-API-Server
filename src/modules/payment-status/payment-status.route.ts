import { authGuard, getTrustedOrigins } from '@/modules/auth';
import { API_V1_PREFIX } from '@/shared/api-version';

import { Elysia } from 'elysia';

import {
  ensurePaymentStatusListener,
  stopPaymentStatusListener,
  subscribeToPaymentStatus,
} from './payment-status.delivery';

const trustedOrigins = getTrustedOrigins(true);
const cleanups = new WeakMap<object, () => void>();

export const paymentStatusRoute = new Elysia({ name: 'payment-status-route' })
  .use(authGuard)
  .derive({ as: 'scoped' }, ({ request }) => ({ paymentOrigin: request.headers.get('origin') }))
  .ws(`${API_V1_PREFIX}/payments/events`, {
    async open(ws) {
      if (ws.data.paymentOrigin !== null && !trustedOrigins.includes(ws.data.paymentOrigin)) {
        ws.close(4403, 'Origin not allowed');
        return;
      }
      const { user, session } = ws.data.session;
      try {
        await ensurePaymentStatusListener();
      } catch {
        ws.close(1013, 'Update service unavailable');
        return;
      }
      const unsubscribe = subscribeToPaymentStatus(user.id, session.id, {
        send: (message) => ws.send(message),
        close: (code, reason) => ws.close(code, reason),
      });
      if (!unsubscribe) {
        ws.close(4429, 'Too many payment connections');
        return;
      }
      const expiryTimer = setTimeout(
        () => {
          cleanups.get(ws)?.();
          ws.close(4401, 'Session expired');
        },
        Math.max(0, session.expiresAt.getTime() - Date.now())
      );
      cleanups.set(ws, () => {
        clearTimeout(expiryTimer);
        unsubscribe();
        cleanups.delete(ws);
      });
      try {
        ws.send(JSON.stringify({ type: 'SUBSCRIBED', version: 1 }));
      } catch {
        cleanups.get(ws)?.();
        ws.close(1011, 'Subscription failed');
      }
    },
    message(ws) {
      ws.close(1008, 'Payment stream is read-only');
    },
    close(ws) {
      cleanups.get(ws)?.();
    },
    detail: {
      tags: ['Payments'],
      summary: 'Subscribe to own Top-up and Payout status changes',
      description:
        'Read-only status invalidations. Fetch current Top-up or Payout state from REST after SUBSCRIBED, each update, and reconnect.',
      operationId: 'subscribePaymentStatus',
    },
  })
  .onStop(() => stopPaymentStatusListener());
