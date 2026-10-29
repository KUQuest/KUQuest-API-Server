import { db, sql as postgresSql } from '@/database/client';

import { sql } from 'drizzle-orm';

import {
  parseAdminUpdateNotification,
  type AdminUpdateNotification,
  type AdminUpdateSubjectType,
} from './admin-update.schema';

const adminUpdateChannel = 'kuquest_admin_updates';
const keepAliveIntervalMs = 15_000;

type AdminUpdateTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type AdminUpdateStreamController = ReadableStreamDefaultController<Uint8Array>;

type Subscription = {
  controller: AdminUpdateStreamController;
  heartbeat: ReturnType<typeof setInterval>;
  expiry: ReturnType<typeof setTimeout>;
};

const subscriptions = new Map<string, Subscription>();
let listenerStart: Promise<void> | undefined;
let unlisten: (() => Promise<void>) | undefined;
let listenerRegistered = false;
let deliveryQueue = Promise.resolve();

const encodeSseData = (event: AdminUpdateNotification) =>
  new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);

const closeSubscription = (id: string, subscription: Subscription) => {
  subscriptions.delete(id);
  clearInterval(subscription.heartbeat);
  clearTimeout(subscription.expiry);
  try {
    subscription.controller.close();
  } catch {
    // The client may have closed the stream already.
  }
};

const closeAllSubscriptions = () => {
  for (const [id, subscription] of subscriptions) closeSubscription(id, subscription);
};

const deliver = (event: AdminUpdateNotification) => {
  const message = encodeSseData(event);
  for (const [id, subscription] of subscriptions) {
    try {
      subscription.controller.enqueue(message);
    } catch {
      closeSubscription(id, subscription);
    }
  }
};

export const notifyAdminResourceUpdated = async (
  transaction: AdminUpdateTransaction,
  subjectType: AdminUpdateSubjectType,
  subjectId: string
) => {
  const event: AdminUpdateNotification = {
    type: 'RESOURCE_UPDATED',
    subjectType,
    subjectId,
  };
  await transaction.execute(sql`select pg_notify(${adminUpdateChannel}, ${JSON.stringify(event)})`);
};

export const ensureAdminUpdateListener = async () => {
  if (!listenerStart) {
    listenerStart = postgresSql
      .listen(
        adminUpdateChannel,
        (payload) => {
          const event = parseAdminUpdateNotification(payload);
          if (!event) return;
          deliveryQueue = deliveryQueue
            .then(() => deliver(event))
            .catch((error: unknown) => {
              console.error('[admin-update] Could not deliver committed update:', error);
              closeAllSubscriptions();
            });
        },
        () => {
          if (listenerRegistered) closeAllSubscriptions();
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

export const subscribeToAdminUpdates = (
  controller: AdminUpdateStreamController,
  expiresAt: Date
) => {
  const id = crypto.randomUUID();
  const heartbeat = setInterval(() => {
    try {
      controller.enqueue(new TextEncoder().encode(': keep-alive\n\n'));
    } catch {
      const current = subscriptions.get(id);
      if (current) closeSubscription(id, current);
    }
  }, keepAliveIntervalMs);
  const expiry = setTimeout(
    () => {
      const current = subscriptions.get(id);
      if (current) closeSubscription(id, current);
    },
    Math.max(0, expiresAt.getTime() - Date.now())
  );

  subscriptions.set(id, { controller, heartbeat, expiry });
  return () => {
    const current = subscriptions.get(id);
    if (current) {
      subscriptions.delete(id);
      clearInterval(current.heartbeat);
      clearTimeout(current.expiry);
    }
  };
};

export const stopAdminUpdateListener = async () => {
  const starting = listenerStart;
  if (starting) await starting.catch(() => undefined);
  const stop = unlisten;
  unlisten = undefined;
  listenerStart = undefined;
  listenerRegistered = false;
  closeAllSubscriptions();
  await stop?.();
};

export const adminUpdateSseResponse = (expiresAt: Date) => {
  let unsubscribe: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(': connected\n\n'));
      unsubscribe = subscribeToAdminUpdates(controller, expiresAt);
    },
    cancel() {
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
};
