import { db, sql as postgresSql } from '@/database/client';

import { sql } from 'drizzle-orm';
import postgres from 'postgres';

import {
  parseAdminUpdateNotification,
  type AdminUpdateNotification,
  type AdminUpdateSubjectType,
} from './admin-update.schema';

const adminUpdateChannel = 'kuquest_admin_updates';
export const adminUpdateListenerApplicationName = `kuquest-admin-${process.pid}-${crypto.randomUUID()}`;
const keepAliveIntervalMs = 15_000;

type AdminUpdateTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type AdminUpdateStreamController = ReadableStreamDefaultController<Uint8Array>;

type Subscription = {
  controller: AdminUpdateStreamController;
  heartbeat: ReturnType<typeof setInterval>;
  expiry: ReturnType<typeof setTimeout>;
};

const subscriptions = new Map<string, Subscription>();
type AdminUpdateListener = {
  client: ReturnType<typeof postgres>;
  registered: boolean;
  start: Promise<void>;
};

let activeListener: AdminUpdateListener | undefined;
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
  let listener = activeListener;
  if (!listener) {
    // postgres.js re-registers cloned listeners on reconnect. A private client lets stop end every clone.
    const client = postgres({
      ...postgresSql.options,
      connection: {
        ...postgresSql.options.connection,
        application_name: adminUpdateListenerApplicationName,
      },
      max: 1,
    } as unknown as postgres.Options<{}>);
    listener = { client, registered: false, start: Promise.resolve() };
    activeListener = listener;
    const currentListener = listener;
    currentListener.start = client
      .listen(
        adminUpdateChannel,
        (payload) => {
          // postgres.js re-registers callbacks on reconnect, even after their owner stops.
          if (activeListener !== currentListener) return;
          const event = parseAdminUpdateNotification(payload);
          if (!event) return;
          deliveryQueue = deliveryQueue
            .then(() => {
              if (activeListener === currentListener) deliver(event);
            })
            .catch((error: unknown) => {
              if (activeListener !== currentListener) return;
              console.error('[admin-update] Could not deliver committed update:', error);
              closeAllSubscriptions();
            });
        },
        () => {
          if (activeListener !== currentListener) return;
          if (currentListener.registered) closeAllSubscriptions();
          currentListener.registered = true;
        }
      )
      .then(() => undefined)
      .catch(async (error: unknown) => {
        if (activeListener === currentListener) activeListener = undefined;
        await client.end().catch(() => undefined);
        throw error;
      });
  }

  await listener.start;
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
  const listener = activeListener;
  activeListener = undefined;
  closeAllSubscriptions();
  if (!listener) return;
  await listener.start.catch(() => undefined);
  await listener.client.end();
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
