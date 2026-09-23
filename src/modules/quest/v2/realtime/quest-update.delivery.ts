import { db, sql as postgresSql } from '@/database/client';
import { authSession } from '@/database/schema/auth.schema';
import { quest } from '@/database/schema/quest.schema';
import type { QuestTransaction } from '@/modules/quest/shared';

import { and, eq, gt, sql as drizzleSql } from 'drizzle-orm';

import { parseQuestUpdateNotification, type QuestUpdateNotification } from './quest-update.schema';
import { getQuestUpdateRoster } from './quest-update.service';

const questUpdateChannel = 'kuquest_quest_updates';

type QuestUpdateSocket = {
  send: (message: string) => unknown;
  close: (code?: number, reason?: string) => unknown;
};

type QuestUpdateSubscription = {
  questId: string;
  memberId: string;
  sessionId: string;
  socket: QuestUpdateSocket;
};

const subscriptions = new Map<string, QuestUpdateSubscription>();
let listenerStart: Promise<void> | undefined;
let unlisten: (() => Promise<void>) | undefined;
let listenerRegistered = false;
let deliveryQueue = Promise.resolve();

const closeSubscription = (
  id: string,
  subscription: QuestUpdateSubscription,
  code: number,
  reason: string
) => {
  subscriptions.delete(id);
  try {
    subscription.socket.close(code, reason);
  } catch {
    // The peer may have closed the socket already.
  }
};

const closeAllSubscriptions = (code: number, reason: string) => {
  for (const [id, subscription] of subscriptions) {
    closeSubscription(id, subscription, code, reason);
  }
};

const sessionIsCurrent = async (subscription: QuestUpdateSubscription) => {
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
  return session !== undefined;
};

const deliverQuestUpdate = async (payload: string) => {
  const event = parseQuestUpdateNotification(payload);
  if (!event) return;

  // Keep the QUEST_OPEN exception limited to Assignment roster invalidations.
  if (event.changeType !== 'ASSIGNMENT_ROSTER_UPDATED') {
    const [current] = await db
      .select({ state: quest.questStatus })
      .from(quest)
      .where(eq(quest.id, event.questId))
      .limit(1);
    if (current?.state === 'QUEST_OPEN') return;
  }

  const message = JSON.stringify({
    type: 'QUEST_UPDATED',
    version: 1,
    questId: event.questId,
    changeType: event.changeType,
    ...('editRequestId' in event ? { editRequestId: event.editRequestId } : {}),
  });
  const recipients = new Set(event.recipientMemberIds);
  const finalRecipients = new Set(event.closeMemberIds ?? []);

  for (const [id, subscription] of subscriptions) {
    if (subscription.questId !== event.questId) continue;

    if (recipients.has(subscription.memberId)) {
      if (!(await sessionIsCurrent(subscription))) {
        closeSubscription(id, subscription, 4401, 'Session expired');
        continue;
      }
      try {
        subscription.socket.send(message);
      } catch {
        closeSubscription(id, subscription, 1011, 'Delivery failed');
        continue;
      }
    }

    if (finalRecipients.has(subscription.memberId)) {
      closeSubscription(id, subscription, 1000, 'Quest access ended');
    }
  }
};

export const notifyQuestUpdate = async (
  transaction: QuestTransaction,
  event: QuestUpdateNotification
) => {
  await transaction.execute(
    drizzleSql`select pg_notify(${questUpdateChannel}, ${JSON.stringify(event)})`
  );
};

export const notifyQuestRosterUpdate = async (transaction: QuestTransaction, questId: string) => {
  const roster = await getQuestUpdateRoster(transaction, questId);
  if (!roster) return;

  await notifyQuestUpdate(transaction, {
    questId,
    recipientMemberIds: [...new Set([roster.hirerId, ...roster.workerIds])],
    changeType: 'ASSIGNMENT_ROSTER_UPDATED',
  });
};

export const subscribeToQuestUpdates = (
  questId: string,
  memberId: string,
  sessionId: string,
  socket: QuestUpdateSocket
) => {
  const id = crypto.randomUUID();
  subscriptions.set(id, { questId, memberId, sessionId, socket });
  return () => subscriptions.delete(id);
};

export const ensureQuestUpdateListener = async () => {
  if (!listenerStart) {
    listenerStart = postgresSql
      .listen(
        questUpdateChannel,
        (payload) => {
          deliveryQueue = deliveryQueue
            .then(() => deliverQuestUpdate(payload))
            .catch((error: unknown) => {
              console.error('[quest-update] Could not deliver committed update:', error);
              closeAllSubscriptions(1013, 'Update service unavailable');
            });
        },
        () => {
          if (listenerRegistered) {
            closeAllSubscriptions(1012, 'Update listener reconnected');
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

export const stopQuestUpdateListener = async () => {
  const starting = listenerStart;
  if (starting) await starting.catch(() => undefined);

  const stop = unlisten;
  unlisten = undefined;
  listenerStart = undefined;
  listenerRegistered = false;
  closeAllSubscriptions(1012, 'API server stopped');
  await stop?.();
};
