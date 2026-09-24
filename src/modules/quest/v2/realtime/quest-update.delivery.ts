import { db, sql as postgresSql } from '@/database/client';
import { authSession } from '@/database/schema/auth.schema';
import { quest, questApiVersion } from '@/database/schema/quest.schema';
import type { QuestTransaction } from '@/modules/quest/shared';

import { and, eq, gt, inArray, sql as drizzleSql } from 'drizzle-orm';

import {
  parseQuestRealtimeNotification,
  type CandidateRosterScope,
  type CandidateRosterUpdateAudience,
  type CandidateRosterUpdateNotification,
  type QuestRealtimeNotification,
  type QuestUpdateChangeType,
  type QuestUpdateNotification,
} from './quest-update.schema';
import { getQuestUpdateRoster } from './quest-update.service';

const questUpdateChannel = 'kuquest_quest_updates';

type HirerQuestChangeType =
  | QuestUpdateChangeType
  | 'CANDIDATE_ROSTER_UPDATED'
  | 'QUEST_PUBLISHED'
  | 'QUEST_CREATED';

type QuestUpdateSocket = {
  send: (message: string) => unknown;
  close: (code?: number, reason?: string) => unknown;
};

type QuestSubscriptionIdentity = {
  memberId: string;
  sessionId: string;
  socket: QuestUpdateSocket;
};

type QuestUpdateSubscription = QuestSubscriptionIdentity & {
  questId: string;
};

type CandidateRosterSubscription = QuestUpdateSubscription & {
  stream: 'CANDIDATE_ROSTER';
  scope: CandidateRosterScope;
};

type QuestBoardSubscription = QuestSubscriptionIdentity & {
  stream: 'QUEST_BOARD';
};

type HirerQuestSubscription = QuestSubscriptionIdentity & {
  stream: 'HIRER_QUESTS';
};

type QuestRealtimeSubscription =
  | (QuestUpdateSubscription & { stream: 'QUEST' })
  | CandidateRosterSubscription
  | QuestBoardSubscription
  | HirerQuestSubscription;

const subscriptions = new Map<string, QuestRealtimeSubscription>();
let listenerStart: Promise<void> | undefined;
let unlisten: (() => Promise<void>) | undefined;
let listenerRegistered = false;
let deliveryQueue = Promise.resolve();

const closeSubscription = (
  id: string,
  subscription: QuestSubscriptionIdentity,
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

const sessionIsCurrent = async (subscription: QuestSubscriptionIdentity) => {
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

const deliverQuestUpdate = async (event: QuestUpdateNotification) => {
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
    if (subscription.stream !== 'QUEST' || subscription.questId !== event.questId) continue;

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

const candidateRosterAudienceMatches = (
  scope: CandidateRosterScope,
  audience: CandidateRosterUpdateAudience
) => {
  switch (audience.kind) {
    case 'HIRER':
      return scope.kind === 'HIRER';
    case 'APPLICATION':
      return scope.kind === 'APPLICATION' && scope.applicationId === audience.applicationId;
    case 'TEAM':
      return scope.kind === 'HIRER' || (scope.kind === 'TEAM' && scope.teamId === audience.teamId);
    case 'QUEST':
      return true;
  }
};

const deliverCandidateRosterUpdate = async (event: CandidateRosterUpdateNotification) => {
  const message = JSON.stringify({
    type: event.type,
    version: 1,
    questId: event.questId,
  });
  const closeMemberIds =
    event.audience.kind === 'TEAM' ? new Set(event.audience.closeMemberIds ?? []) : undefined;
  const closeAll = event.audience.kind === 'QUEST' && event.audience.closeAll;

  for (const [id, subscription] of subscriptions) {
    if (subscription.stream !== 'CANDIDATE_ROSTER' || subscription.questId !== event.questId)
      continue;

    const receivesUpdate = candidateRosterAudienceMatches(subscription.scope, event.audience);
    const removedMember = closeMemberIds?.has(subscription.memberId) ?? false;
    const losesAccess = closeAll || removedMember;
    if (!receivesUpdate && !losesAccess) continue;

    if (receivesUpdate && !removedMember) {
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

    if (losesAccess) {
      closeSubscription(id, subscription, 4403, 'Candidate roster access ended');
    }
  }
};

const deliverQuestBoardInvalidated = async (
  event: Extract<QuestRealtimeNotification, { type: 'QUEST_BOARD_INVALIDATED' }>
) => {
  const boardSubscriptions: Array<[string, QuestBoardSubscription]> = [];
  for (const [id, subscription] of subscriptions) {
    if (subscription.stream === 'QUEST_BOARD') boardSubscriptions.push([id, subscription]);
  }
  if (boardSubscriptions.length === 0) return;

  const activeSessions = await db
    .select({ id: authSession.id, userId: authSession.userId })
    .from(authSession)
    .where(
      and(
        inArray(authSession.id, [
          ...new Set(boardSubscriptions.map(([, subscription]) => subscription.sessionId)),
        ]),
        gt(authSession.expiresAt, new Date())
      )
    );
  const activeSessionKeys = new Set(activeSessions.map(({ id, userId }) => `${id}:${userId}`));
  const message = JSON.stringify({
    type: 'QUEST_BOARD_INVALIDATED',
    version: 1,
    questId: event.questId,
  });

  for (const [id, subscription] of boardSubscriptions) {
    if (!activeSessionKeys.has(`${subscription.sessionId}:${subscription.memberId}`)) {
      closeSubscription(id, subscription, 4401, 'Session expired');
      continue;
    }
    try {
      subscription.socket.send(message);
    } catch {
      closeSubscription(id, subscription, 1011, 'Delivery failed');
    }
  }
};

const deliverHirerQuestUpdate = async (questId: string, changeType: HirerQuestChangeType) => {
  const hirerSubscriptions: Array<[string, HirerQuestSubscription]> = [];
  for (const [id, subscription] of subscriptions) {
    if (subscription.stream === 'HIRER_QUESTS') hirerSubscriptions.push([id, subscription]);
  }
  if (hirerSubscriptions.length === 0) return;

  const [currentQuest] = await db
    .select({ hirerId: quest.hirerId })
    .from(quest)
    .where(and(eq(quest.id, questId), eq(quest.apiVersion, questApiVersion.v2)))
    .limit(1);
  if (!currentQuest) return;

  const hirerSessions = hirerSubscriptions.filter(
    ([, subscription]) => subscription.memberId === currentQuest.hirerId
  );
  if (hirerSessions.length === 0) return;

  const activeSessions = await db
    .select({ id: authSession.id, userId: authSession.userId })
    .from(authSession)
    .where(
      and(
        inArray(authSession.id, [
          ...new Set(hirerSessions.map(([, subscription]) => subscription.sessionId)),
        ]),
        gt(authSession.expiresAt, new Date())
      )
    );
  const activeSessionKeys = new Set(activeSessions.map(({ id, userId }) => `${id}:${userId}`));
  const message = JSON.stringify({
    type: 'HIRER_QUEST_UPDATED',
    version: 1,
    questId,
    changeType,
  });

  for (const [id, subscription] of hirerSessions) {
    if (!activeSessionKeys.has(`${subscription.sessionId}:${subscription.memberId}`)) {
      closeSubscription(id, subscription, 4401, 'Session expired');
      continue;
    }
    try {
      subscription.socket.send(message);
    } catch {
      closeSubscription(id, subscription, 1011, 'Delivery failed');
    }
  }
};

const deliverQuestRealtimeNotification = async (event: QuestRealtimeNotification) => {
  if ('type' in event) {
    if (event.type === 'CANDIDATE_ROSTER_UPDATED') {
      await deliverCandidateRosterUpdate(event);
      if (event.audience.kind !== 'APPLICATION') {
        await deliverHirerQuestUpdate(event.questId, 'CANDIDATE_ROSTER_UPDATED');
      }
    } else if (event.type === 'QUEST_BOARD_INVALIDATED') {
      await deliverQuestBoardInvalidated(event);
      await deliverHirerQuestUpdate(event.questId, 'QUEST_PUBLISHED');
    } else {
      await deliverHirerQuestUpdate(event.questId, 'QUEST_CREATED');
    }
    return;
  }

  await deliverHirerQuestUpdate(event.questId, event.changeType);
  await deliverQuestUpdate(event);
  if (
    event.changeType === 'QUEST_STARTED' ||
    event.changeType === 'QUEST_COMPLETED' ||
    event.changeType === 'QUEST_FAILED' ||
    event.changeType === 'QUEST_CANCELLED'
  ) {
    await deliverCandidateRosterUpdate({
      questId: event.questId,
      type: 'CANDIDATE_ROSTER_UPDATED',
      audience: { kind: 'QUEST', closeAll: true },
    });
  }
};

const notifyQuestRealtimeUpdate = async (
  transaction: QuestTransaction,
  event: QuestRealtimeNotification
) => {
  await transaction.execute(
    drizzleSql`select pg_notify(${questUpdateChannel}, ${JSON.stringify(event)})`
  );
};

export const notifyQuestUpdate = async (
  transaction: QuestTransaction,
  event: QuestUpdateNotification
) => notifyQuestRealtimeUpdate(transaction, event);

export const notifyCandidateRosterUpdate = async (
  transaction: QuestTransaction,
  questId: string,
  audience: CandidateRosterUpdateAudience
) =>
  notifyQuestRealtimeUpdate(transaction, {
    questId,
    type: 'CANDIDATE_ROSTER_UPDATED',
    audience,
  });

export const notifyQuestBoardInvalidated = async (transaction: QuestTransaction, questId: string) =>
  notifyQuestRealtimeUpdate(transaction, { questId, type: 'QUEST_BOARD_INVALIDATED' });

export const notifyHirerQuestCreated = async (transaction: QuestTransaction, questId: string) =>
  notifyQuestRealtimeUpdate(transaction, { questId, type: 'QUEST_CREATED' });

export const notifyQuestRosterUpdate = async (transaction: QuestTransaction, questId: string) => {
  const roster = await getQuestUpdateRoster(transaction, questId);
  if (!roster) return;

  await notifyQuestUpdate(transaction, {
    questId,
    recipientMemberIds: [...new Set([roster.hirerId, ...roster.workerIds])],
    changeType: 'ASSIGNMENT_ROSTER_UPDATED',
  });
};

const subscribe = (subscription: QuestRealtimeSubscription) => {
  const id = crypto.randomUUID();
  subscriptions.set(id, subscription);
  return () => subscriptions.delete(id);
};

export const subscribeToQuestUpdates = (
  questId: string,
  memberId: string,
  sessionId: string,
  socket: QuestUpdateSocket
) => subscribe({ stream: 'QUEST', questId, memberId, sessionId, socket });

export const subscribeToCandidateRosterUpdates = (
  questId: string,
  memberId: string,
  sessionId: string,
  scope: CandidateRosterScope,
  socket: QuestUpdateSocket
) => subscribe({ stream: 'CANDIDATE_ROSTER', questId, memberId, sessionId, scope, socket });

export const subscribeToQuestBoardUpdates = (
  memberId: string,
  sessionId: string,
  socket: QuestUpdateSocket
) => subscribe({ stream: 'QUEST_BOARD', memberId, sessionId, socket });

export const subscribeToHirerQuestUpdates = (
  memberId: string,
  sessionId: string,
  socket: QuestUpdateSocket
) => subscribe({ stream: 'HIRER_QUESTS', memberId, sessionId, socket });

export const ensureQuestUpdateListener = async () => {
  if (!listenerStart) {
    listenerStart = postgresSql
      .listen(
        questUpdateChannel,
        (payload) => {
          const event = parseQuestRealtimeNotification(payload);
          if (!event) return;
          deliveryQueue = deliveryQueue
            .then(() => deliverQuestRealtimeNotification(event))
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
