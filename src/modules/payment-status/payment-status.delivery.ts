import { db, sql as postgresSql } from '@/database/client';
import { authSession } from '@/database/schema/auth.schema';
import type { WalletTransaction } from '@/modules/wallet';

import { Value } from '@sinclair/typebox/value';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { t } from 'elysia';

const channel = 'kuquest_payment_status';
const maxSocketsPerMember = 2;
const maxSocketsPerProcess = 500;

const notificationSchema = t.Object({
  memberId: t.String({ format: 'uuid' }),
  resourceType: t.Union([t.Literal('TOP_UP'), t.Literal('PAYOUT')]),
  resourceId: t.String({ format: 'uuid' }),
});

type Notification = typeof notificationSchema.static;
type PaymentSocket = {
  send: (message: string) => number;
  close: (code: number, reason: string) => unknown;
};
type Subscription = {
  sessionId: string;
  socket: PaymentSocket;
};

const subscribers = new Map<string, Set<Subscription>>();
let socketCount = 0;
let listenerStart: Promise<void> | undefined;
let unlisten: (() => Promise<void>) | undefined;
let listenerRegistered = false;

const removeSubscription = (memberId: string, subscription: Subscription) => {
  const group = subscribers.get(memberId);
  if (!group?.delete(subscription)) return;
  socketCount -= 1;
  if (group.size === 0) subscribers.delete(memberId);
};

const closeSubscription = (
  memberId: string,
  subscription: Subscription,
  code: number,
  reason: string
) => {
  removeSubscription(memberId, subscription);
  try {
    subscription.socket.close(code, reason);
  } catch {
    // A disconnected peer cannot receive the close frame.
  }
};

const closeAll = (code: number, reason: string) => {
  for (const [memberId, group] of subscribers) {
    for (const subscription of group) closeSubscription(memberId, subscription, code, reason);
  }
};

const deliver = async (event: Notification) => {
  const group = subscribers.get(event.memberId);
  if (!group) return;
  const currentSubscriptions = [...group];
  const sessions = await db
    .select({ id: authSession.id })
    .from(authSession)
    .where(
      and(
        inArray(
          authSession.id,
          currentSubscriptions.map(({ sessionId }) => sessionId)
        ),
        eq(authSession.userId, event.memberId),
        gt(authSession.expiresAt, new Date())
      )
    );
  const activeSessions = new Set(sessions.map(({ id }) => id));
  const message = JSON.stringify({
    type: 'PAYMENT_STATUS_CHANGED',
    version: 1,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
  });
  for (const subscription of currentSubscriptions) {
    if (!group.has(subscription)) continue;
    if (!activeSessions.has(subscription.sessionId)) {
      closeSubscription(event.memberId, subscription, 4401, 'Session expired');
      continue;
    }
    try {
      if (subscription.socket.send(message) <= 0) {
        closeSubscription(event.memberId, subscription, 1013, 'Delivery unavailable');
      }
    } catch {
      closeSubscription(event.memberId, subscription, 1011, 'Delivery failed');
    }
  }
};

export const notifyPaymentStatus = async (transaction: WalletTransaction, event: Notification) => {
  await transaction.execute(sql`select pg_notify(${channel}, ${JSON.stringify(event)})`);
};

export const subscribeToPaymentStatus = (
  memberId: string,
  sessionId: string,
  socket: PaymentSocket
): (() => void) | undefined => {
  if (socketCount >= maxSocketsPerProcess) return undefined;
  let group = subscribers.get(memberId);
  if (!group) {
    group = new Set();
    subscribers.set(memberId, group);
  }
  if (group.size >= maxSocketsPerMember) return undefined;
  const subscription = { sessionId, socket };
  group.add(subscription);
  socketCount += 1;
  return () => removeSubscription(memberId, subscription);
};

export const ensurePaymentStatusListener = async () => {
  if (!listenerStart) {
    listenerStart = postgresSql
      .listen(
        channel,
        (payload) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(payload);
          } catch {
            return;
          }
          if (!Value.Check(notificationSchema, parsed)) return;
          void deliver(parsed).catch((error: unknown) => {
            console.error('[payment-status] Could not deliver committed update:', error);
            closeAll(1013, 'Update service unavailable');
          });
        },
        () => {
          if (listenerRegistered) closeAll(1012, 'Update listener reconnected');
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

export const stopPaymentStatusListener = async () => {
  if (listenerStart) await listenerStart.catch(() => undefined);
  const stop = unlisten;
  listenerStart = undefined;
  unlisten = undefined;
  listenerRegistered = false;
  closeAll(1012, 'API server stopped');
  await stop?.();
};
