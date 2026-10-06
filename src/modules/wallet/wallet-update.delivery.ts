import { db, sql as postgresSql } from '@/database/client';
import { authSession } from '@/database/schema/auth.schema';
import { closeSocketForActiveMemberBan } from '@/modules/auth';

import { and, eq, gt } from 'drizzle-orm';

const walletUpdateChannel = 'kuquest_wallet_updates';

type WalletUpdate =
  | { memberId: string; type: 'WALLET_UPDATED' }
  | { memberId: string; type: 'TOP_UP_UPDATED'; topUpId: string };
type WalletSocket = {
  send: (message: string) => unknown;
  close: (code?: number, reason?: string) => unknown;
};
type Subscription = {
  memberId: string;
  sessionId: string;
  socket: WalletSocket;
  expiresAt: Date;
  expiryTimer: ReturnType<typeof setTimeout>;
};

const subscriptions = new Map<string, Subscription>();
let listenerStart: Promise<void> | undefined;
let unlisten: (() => Promise<void>) | undefined;
let listenerRegistered = false;

const parseUpdate = (payload: string): WalletUpdate | undefined => {
  try {
    const update: unknown = JSON.parse(payload);
    if (typeof update !== 'object' || update === null) return undefined;
    const value = update as Record<string, unknown>;
    if (typeof value.memberId !== 'string') return undefined;
    if (value.type === 'WALLET_UPDATED') return { memberId: value.memberId, type: value.type };
    if (value.type === 'TOP_UP_UPDATED' && typeof value.topUpId === 'string') {
      return { memberId: value.memberId, type: value.type, topUpId: value.topUpId };
    }
  } catch {
    return undefined;
  }
  return undefined;
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

const deliver = async (event: WalletUpdate) => {
  const recipients = [...subscriptions.entries()].filter(
    ([, subscription]) => subscription.memberId === event.memberId
  );
  await Promise.all(
    recipients.map(async ([id, subscription]) => {
      if (await closeSocketForActiveMemberBan(subscription.socket, subscription.memberId)) {
        closeSubscription(id, subscription, 4403, 'Member access ended');
        return;
      }
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
        subscription.socket.send(
          JSON.stringify({
            version: 1,
            type: event.type,
            ...('topUpId' in event ? { topUpId: event.topUpId } : {}),
          })
        );
      } catch {
        closeSubscription(id, subscription, 1011, 'Delivery failed');
      }
    })
  );
};

export const ensureWalletUpdateListener = async () => {
  if (!listenerStart) {
    listenerStart = postgresSql
      .listen(
        walletUpdateChannel,
        (payload) => {
          const event = parseUpdate(payload);
          if (event) void deliver(event);
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

export const subscribeToWalletUpdates = (
  memberId: string,
  sessionId: string,
  expiresAt: Date,
  socket: WalletSocket
) => {
  const id = crypto.randomUUID();
  const expiryTimer = setTimeout(
    () => {
      const current = subscriptions.get(id);
      if (current) closeSubscription(id, current, 4401, 'Session expired');
    },
    Math.max(0, expiresAt.getTime() - Date.now())
  );
  subscriptions.set(id, { memberId, sessionId, expiresAt, socket, expiryTimer });
  return () => {
    const current = subscriptions.get(id);
    if (current) {
      clearTimeout(expiryTimer);
      subscriptions.delete(id);
    }
  };
};

export const stopWalletUpdateListener = async () => {
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
