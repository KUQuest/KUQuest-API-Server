import { authGuard, getTrustedOrigins } from '@/modules/auth';
import { API_V1_PREFIX } from '@/shared/api-version';
import { logSocket } from '@/shared/request-log';

import { Elysia } from 'elysia';

import {
  ensureNotificationEventsListener,
  stopNotificationEventsListener,
  subscribeToNotificationEvents,
} from './notification.events.hub';

const socketCleanups = new WeakMap<object, () => void>();
const trustedOrigins = getTrustedOrigins(true);

/**
 * Inbox invalidation socket. It has no memberBanGuard on purpose: a banned Member with a
 * live session may still listen, like the inbox routes.
 */
export const notificationEventsRoute = new Elysia({
  name: 'notification-events-route',
  prefix: `${API_V1_PREFIX}/notifications`,
})
  .use(authGuard)
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
        await ensureNotificationEventsListener();
        const unsubscribe = subscribeToNotificationEvents(user.id, session.id, session.expiresAt, {
          send: (message) => {
            ws.send(message);
            logSocket(ws, 'send', { type: 'NOTIFICATIONS_CHANGED' });
          },
          close: (code, reason) => ws.close(code, reason),
        });
        socketCleanups.set(ws, unsubscribe);
        ws.send(JSON.stringify({ type: 'SUBSCRIBED', version: 1 }));
        logSocket(ws, 'subscribed');
      } catch {
        ws.close(1013, 'Notification update service unavailable');
      }
    },
    message(ws) {
      logSocket(ws, 'rejected', { type: 'READ_ONLY_COMMAND', code: 1008 });
      ws.close(1008, 'Notification update stream is read-only');
    },
    close(ws, code) {
      socketCleanups.get(ws)?.();
      socketCleanups.delete(ws);
      logSocket(ws, 'close', { code });
    },
    detail: {
      tags: ['Notification'],
      summary: 'Subscribe to Member inbox updates',
      description:
        'Subscribes the authenticated Member to inbox invalidations. Each NOTIFICATIONS_CHANGED frame has no data. Reload the inbox and the unread count from REST after each frame and after each reconnect.',
      operationId: 'subscribeMemberNotificationUpdates',
    },
  })
  .onStop(() => stopNotificationEventsListener());
