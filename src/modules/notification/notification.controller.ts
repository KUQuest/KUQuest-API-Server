import type { AuthenticatedSession } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import { CursorInputError, decodeCursor, encodeCursor, parsePageLimit } from '@/shared/cursor';

import type { Static } from 'elysia';
import type { StatusMap } from 'elysia/utils';

import {
  countUnreadMemberNotifications,
  listMemberNotifications,
  markMemberNotificationsRead,
} from './notification.read.service';
import type {
  listNotificationsQuerySchema,
  markNotificationsReadSchema,
} from './notification.schema';

type NotificationContext = {
  session: AuthenticatedSession;
  set: { status?: number | keyof StatusMap };
};

export const listNotificationsController = async ({
  session,
  query,
  set,
}: NotificationContext & { query: Static<typeof listNotificationsQuerySchema> }) => {
  try {
    const result = await listMemberNotifications(session.user.id, {
      limit: parsePageLimit(query.limit),
      cursor: decodeCursor(query.cursor),
      unreadOnly: query.unreadOnly,
    });
    return apiSuccess({
      items: result.items.map((item) => ({
        id: item.id,
        type: item.type,
        createdAt: item.createdAt.toISOString(),
        readAt: item.readAt?.toISOString() ?? null,
        questId: item.questId,
        result: item.result,
        expiresAt: item.expiresAt?.toISOString() ?? null,
      })),
      nextCursor: result.nextCursor ? encodeCursor(result.nextCursor) : null,
    });
  } catch (error) {
    if (!(error instanceof CursorInputError)) throw error;
    set.status = 400;
    return apiError(error.code, error.message);
  }
};

export const unreadNotificationCountController = async ({ session }: NotificationContext) =>
  apiSuccess({ count: await countUnreadMemberNotifications(session.user.id) });

export const markNotificationsReadController = async ({
  session,
  body,
  set,
}: NotificationContext & { body: Static<typeof markNotificationsReadSchema> }) => {
  const hasIds = body.ids !== undefined;
  const hasAll = body.all !== undefined;
  if (hasIds === hasAll) {
    set.status = 400;
    return apiError('INVALID_NOTIFICATION_READ_TARGET', 'Send either ids or all, not both.');
  }
  await markMemberNotificationsRead(
    session.user.id,
    body.ids ? { ids: body.ids } : { all: true },
    new Date()
  );
  return apiSuccess();
};
