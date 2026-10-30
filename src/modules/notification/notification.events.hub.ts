import { db, sql as postgresSql } from '@/database/client';
import { authSession } from '@/database/schema/auth.schema';

import { and, eq, gt } from 'drizzle-orm';

import { notificationEventsChannel } from './notification.events.publisher';

type NotificationSocket = {
  send: (message: string) => unknown;
  close: (code?: number, reason?: string) => unknown;
};
type Subscription = {
  memberId: string;
  sessionId: string;
  socket: NotificationSocket;
  expiryTimer: ReturnType<typeof setTimeout>;
};

const changedFrame = JSON.stringify({ type: 'NOTIFICATIONS_CHANGED' });
const subscriptions = new Map<string, Subscription>();
let listenerStart: Promise<void> | undefined;
let unlisten: (() => Promise<void>) | undefined;
let listenerRegistered = false;

const parseMemberId = (payload: string): string | undefined => {
  try {
    const value: unknown = JSON.parse(payload);
    if (typeof value !== 'object' || value === null) return undefined;
    const { memberId } = value as Record<string, unknown>;
    return typeof memberId === 'string' && memberId !== '' ? memberId : undefined;
  } catch {
    return undefined;
  }
};

const closeSubscription = (
  id: string,
  subscription: Subscription,
  code: number,
  reason: string
) => {
  subscriptions.delete(id);
  clearTimeout(subscription.expiryTimer);
  try {
    subscription.socket.close(code, reason);
  } catch {
    // The peer may already be closed.
  }
};

/**
 * A Member Ban does not stop a listener. A banned Member with a live session still reads
 * the inbox, so only the session is checked here.
 */
const deliver = async (memberId: string) => {
  const recipients = [...subscriptions.entries()].filter(
    ([, subscription]) => subscription.memberId === memberId
  );
  await Promise.all(
    recipients.map(async ([id, subscription]) => {
      const [session] = await db
        .select({ id: authSession.id })
        .from(authSession)
        .where(
          and(
            eq(authSession.id, subscription.sessionId),
            eq(authSession.userId, subscription.memberId),
            gt(authSession.expiresAt, new Date())
          )
        )
        .limit(1);
      if (!session) {
        closeSubscription(id, subscription, 4401, 'Session expired');
        return;
      }
      try {
        subscription.socket.send(changedFrame);
      } catch {
        closeSubscription(id, subscription, 1011, 'Delivery failed');
      }
    })
  );
};

export const ensureNotificationEventsListener = async () => {
  if (!listenerStart) {
    listenerStart = postgresSql
      .listen(
        notificationEventsChannel,
        (payload) => {
          const memberId = parseMemberId(payload);
          if (memberId) void deliver(memberId);
        },
        () => {
          if (listenerRegistered) {
            for (const [id, subscription] of subscriptions) {
              closeSubscription(id, subscription, 1012, 'Update listener reconnected');
            }
          }
          listenerRegistered = true;
        }
      )
      .then((listener) => {
        unlisten = listener.unlisten;
      })
      .catch((error: unknown) => {
        listenerStart = undefined;
        throw error;
      });
  }
  await listenerStart;
};

export const subscribeToNotificationEvents = (
  memberId: string,
  sessionId: string,
  expiresAt: Date,
  socket: NotificationSocket
) => {
  const id = crypto.randomUUID();
  const expiryTimer = setTimeout(
    () => {
      const current = subscriptions.get(id);
      if (current) closeSubscription(id, current, 4401, 'Session expired');
    },
    Math.max(0, expiresAt.getTime() - Date.now())
  );
  subscriptions.set(id, { memberId, sessionId, socket, expiryTimer });
  return () => {
    const current = subscriptions.get(id);
    if (current) {
      clearTimeout(expiryTimer);
      subscriptions.delete(id);
    }
  };
};

export const stopNotificationEventsListener = async () => {
  const starting = listenerStart;
  if (starting) await starting.catch(() => undefined);
  const stop = unlisten;
  unlisten = undefined;
  listenerStart = undefined;
  listenerRegistered = false;
  for (const [id, subscription] of subscriptions) {
    closeSubscription(id, subscription, 1012, 'API server stopped');
  }
  await stop?.();
};
