import { authGuard, memberBanGuard, getTrustedOrigins } from '@/modules/auth';
import { API_V2_PREFIX } from '@/shared/api-version';

import { Elysia } from 'elysia';

import {
  ensureQuestUpdateListener,
  stopQuestUpdateListener,
  subscribeToCandidateRosterUpdates,
  subscribeToQuestBoardUpdates,
  subscribeToQuestUpdates,
} from './quest-update.delivery';
import { questUpdateParamsSchema } from './quest-update.schema';
import type { CandidateRosterScope, QuestUpdateAccess } from './quest-update.schema';
import {
  getCandidateRosterAccess,
  getQuestBoardUpdateAccess,
  getQuestUpdateAccess,
} from './quest-update.service';

const trustedOrigins = getTrustedOrigins(true);
const socketCleanups = new WeakMap<object, () => void>();

type QuestRealtimeSocket = {
  send: (message: string) => unknown;
  close: (code?: number, reason?: string) => unknown;
};

const sameCandidateRosterScope = (left: CandidateRosterScope, right: CandidateRosterScope) => {
  switch (left.kind) {
    case 'HIRER':
      return right.kind === 'HIRER';
    case 'APPLICATION':
      return right.kind === 'APPLICATION' && left.applicationId === right.applicationId;
    case 'TEAM':
      return right.kind === 'TEAM' && left.teamId === right.teamId;
  }
};

const openRealtimeSubscription = async <T>({
  socket,
  origin,
  subscribedMessage,
  expiresAt,
  accessDeniedReason,
  checkAccess,
  sameAccess,
  subscribe,
}: {
  socket: QuestRealtimeSocket;
  origin: string | null;
  subscribedMessage: Record<string, string | number>;
  expiresAt: Date;
  accessDeniedReason: string;
  checkAccess: () => Promise<T | undefined>;
  sameAccess: (initial: T, current: T) => boolean;
  subscribe: (access: T) => () => void;
}) => {
  if (origin !== null && !trustedOrigins.includes(origin)) {
    socket.close(4403, 'Origin not allowed');
    return;
  }

  let access: T | undefined;
  try {
    access = await checkAccess();
  } catch {
    socket.close(1013, 'Update service unavailable');
    return;
  }
  if (!access) {
    socket.close(4403, accessDeniedReason);
    return;
  }

  try {
    await ensureQuestUpdateListener();
  } catch {
    socket.close(1013, 'Update service unavailable');
    return;
  }

  const unsubscribe = subscribe(access);
  let currentAccess: T | undefined;
  try {
    currentAccess = await checkAccess();
  } catch {
    unsubscribe();
    socket.close(1013, 'Update service unavailable');
    return;
  }
  if (!currentAccess || !sameAccess(access, currentAccess)) {
    unsubscribe();
    socket.close(4403, accessDeniedReason);
    return;
  }

  const expiryTimer = setTimeout(
    () => {
      socketCleanups.get(socket)?.();
      socket.close(4401, 'Session expired');
    },
    Math.max(0, expiresAt.getTime() - Date.now())
  );
  socketCleanups.set(socket, () => {
    clearTimeout(expiryTimer);
    unsubscribe();
    socketCleanups.delete(socket);
  });

  try {
    socket.send(JSON.stringify(subscribedMessage));
  } catch {
    socketCleanups.get(socket)?.();
    socket.close(1011, 'Subscription failed');
  }
};

export const questV2RealtimeRoute = new Elysia({ name: 'quest-v2-realtime-route' })
  .use(authGuard)
  .use(memberBanGuard)
  .derive({ as: 'scoped' }, ({ request }) => ({ questOrigin: request.headers.get('origin') }))
  .ws(`${API_V2_PREFIX}/quests/board/events`, {
    async open(ws) {
      const { user, session } = ws.data.session;
      await openRealtimeSubscription<string>({
        socket: ws,
        origin: ws.data.questOrigin,
        subscribedMessage: { type: 'SUBSCRIBED', version: 1, scope: 'QUEST_BOARD' },
        expiresAt: session.expiresAt,
        accessDeniedReason: 'Quest Board access not allowed',
        checkAccess: () => getQuestBoardUpdateAccess(user.id, session.id),
        sameAccess: (initial, current) => initial === current,
        subscribe: () =>
          subscribeToQuestBoardUpdates(user.id, session.id, {
            send: (message) => ws.send(message),
            close: (code, reason) => ws.close(code, reason),
          }),
      });
    },
    message(ws) {
      ws.close(1008, 'Quest Board stream is read-only');
    },
    close(ws) {
      socketCleanups.get(ws)?.();
    },
    detail: {
      tags: ['Quest'],
      summary: 'Subscribe to Quest Board updates',
      description:
        'Subscribes an authenticated Member to Quest Board invalidations. Read the Board from REST after SUBSCRIBED and each invalidation.',
      operationId: 'subscribeQuestBoardUpdates',
    },
  })
  .ws(`${API_V2_PREFIX}/quests/:questId/events`, {
    params: questUpdateParamsSchema,
    async open(ws) {
      const { questId } = ws.data.params;
      const { user, session } = ws.data.session;
      await openRealtimeSubscription<QuestUpdateAccess>({
        socket: ws,
        origin: ws.data.questOrigin,
        subscribedMessage: { type: 'SUBSCRIBED', version: 1, questId },
        expiresAt: session.expiresAt,
        accessDeniedReason: 'Quest access not allowed',
        checkAccess: () => getQuestUpdateAccess(user.id, questId),
        sameAccess: (initial, current) =>
          initial.role === current.role && initial.mode === current.mode,
        subscribe: () =>
          subscribeToQuestUpdates(questId, user.id, session.id, {
            send: (message) => ws.send(message),
            close: (code, reason) => ws.close(code, reason),
          }),
      });
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
  .ws(`${API_V2_PREFIX}/quests/:questId/candidate-roster/events`, {
    params: questUpdateParamsSchema,
    async open(ws) {
      const { questId } = ws.data.params;
      const { user, session } = ws.data.session;
      await openRealtimeSubscription<CandidateRosterScope>({
        socket: ws,
        origin: ws.data.questOrigin,
        subscribedMessage: { type: 'SUBSCRIBED', version: 1, questId },
        expiresAt: session.expiresAt,
        accessDeniedReason: 'Candidate roster access not allowed',
        checkAccess: () => getCandidateRosterAccess(user.id, questId),
        sameAccess: sameCandidateRosterScope,
        subscribe: (scope) =>
          subscribeToCandidateRosterUpdates(questId, user.id, session.id, scope, {
            send: (message) => ws.send(message),
            close: (code, reason) => ws.close(code, reason),
          }),
      });
    },
    message(ws) {
      ws.close(1008, 'Candidate roster stream is read-only');
    },
    close(ws) {
      socketCleanups.get(ws)?.();
    },
    detail: {
      tags: ['Quest'],
      summary: 'Subscribe to read-only Candidate roster updates',
      description:
        'Subscribes a Hirer or Candidate who can read the Candidate applications or Candidate Teams. Read roster data from REST after SUBSCRIBED and each invalidation.',
      operationId: 'subscribeCandidateRosterUpdates',
    },
  })
  .onStop(() => stopQuestUpdateListener());
