import { authGuard, getTrustedOrigins } from '@/modules/auth';
import { API_V2_PREFIX } from '@/shared/api-version';

import { Elysia } from 'elysia';

import {
  ensureQuestUpdateListener,
  stopQuestUpdateListener,
  subscribeToQuestUpdates,
} from './quest-update.delivery';
import { questUpdateParamsSchema } from './quest-update.schema';
import { getQuestUpdateAccess } from './quest-update.service';

const trustedOrigins = getTrustedOrigins(true);
const socketCleanups = new WeakMap<object, () => void>();

export const questV2RealtimeRoute = new Elysia({ name: 'quest-v2-realtime-route' })
  .use(authGuard)
  .derive({ as: 'scoped' }, ({ request }) => ({ questOrigin: request.headers.get('origin') }))
  .ws(`${API_V2_PREFIX}/quests/:questId/events`, {
    params: questUpdateParamsSchema,
    async open(ws) {
      if (ws.data.questOrigin !== null && !trustedOrigins.includes(ws.data.questOrigin)) {
        ws.close(4403, 'Origin not allowed');
        return;
      }

      const { questId } = ws.data.params;
      const { user, session } = ws.data.session;
      try {
        if (!(await getQuestUpdateAccess(user.id, questId))) {
          ws.close(4403, 'Quest access not allowed');
          return;
        }
        await ensureQuestUpdateListener();
      } catch {
        ws.close(1013, 'Update service unavailable');
        return;
      }

      const unsubscribe = subscribeToQuestUpdates(questId, user.id, session.id, {
        send: (message) => ws.send(message),
        close: (code, reason) => ws.close(code, reason),
      });

      try {
        if (!(await getQuestUpdateAccess(user.id, questId))) {
          unsubscribe();
          ws.close(4403, 'Quest access not allowed');
          return;
        }
      } catch {
        unsubscribe();
        ws.close(1013, 'Update service unavailable');
        return;
      }

      const expiryTimer = setTimeout(
        () => {
          socketCleanups.get(ws)?.();
          ws.close(4401, 'Session expired');
        },
        Math.max(0, session.expiresAt.getTime() - Date.now())
      );
      socketCleanups.set(ws, () => {
        clearTimeout(expiryTimer);
        unsubscribe();
        socketCleanups.delete(ws);
      });

      try {
        ws.send(JSON.stringify({ type: 'SUBSCRIBED', version: 1, questId }));
      } catch {
        socketCleanups.get(ws)?.();
        ws.close(1011, 'Subscription failed');
      }
    },
    message(ws) {
      ws.close(1008, 'Quest stream is read-only');
    },
    close(ws) {
      socketCleanups.get(ws)?.();
    },
    detail: {
      tags: ['Quest'],
      summary: 'Subscribe to read-only Quest updates',
      description:
        'Subscribes an authorized Hirer or Worker to current Quest updates. Read Quest state from REST after SUBSCRIBED.',
      operationId: 'subscribeQuestUpdates',
    },
  })
  .onStop(() => stopQuestUpdateListener());
