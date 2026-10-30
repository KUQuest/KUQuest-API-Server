import type { AuthenticatedSession } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import { CursorInputError, decodeCursor, encodeCursor, parsePageLimit } from '@/shared/cursor';

import type { Static } from 'elysia';
import type { StatusMap } from 'elysia/utils';

import {
  countUnreadMemberNotifications,
  dismissMemberNotifications,
  listMemberNotifications,
  markMemberNotificationsRead,
} from './notification.read.service';
import type {
  dismissNotificationsSchema,
  listNotificationsQuerySchema,
  markNotificationsReadSchema,
} from './notification.schema';
import { categoryOfNotificationType } from './notification.types';

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
      categories: query.category,
    });
    return apiSuccess({
      items: result.items.map((item) => ({
        id: item.id,
        type: item.type,
        category: categoryOfNotificationType(item.type),
        createdAt: item.createdAt.toISOString(),
        readAt: item.readAt?.toISOString() ?? null,
        questId: item.questId,
        questTitle: item.questTitle,
        actorRole: item.actorRole,
        result: item.result,
        expiresAt: item.expiresAt?.toISOString() ?? null,
        cancellationReason: item.cancellationReason,
        failureReason: item.failureReason,
        assignmentId: item.assignmentId,
        disputeCaseId: item.disputeCaseId,
        disputeStatus: item.disputeStatus,
        viewerWon: item.viewerWon,
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
  apiSuccess(await countUnreadMemberNotifications(session.user.id));

export const markNotificationsReadController = async ({
  session,
  body,
  set,
}: NotificationContext & { body: Static<typeof markNotificationsReadSchema> }) => {
  const hasIds = body.ids !== undefined;
  const hasAll = body.all !== undefined;
  // One form only. A category narrows `all`; it has no meaning for a list of ids.
  if (hasIds === hasAll || (hasIds && body.category !== undefined)) {
    set.status = 400;
    return apiError(
      'INVALID_NOTIFICATION_READ_TARGET',
      'Send either ids or all. A category is allowed only with all.'
    );
  }
  await markMemberNotificationsRead(
    session.user.id,
    body.ids
      ? { ids: body.ids }
      : {
          all: true,
          categories:
            body.category === undefined
              ? undefined
              : Array.isArray(body.category)
                ? body.category
                : [body.category],
        },
    new Date()
  );
  return apiSuccess();
};

export const dismissNotificationsController = async ({
  session,
  body,
  set,
}: NotificationContext & { body: Static<typeof dismissNotificationsSchema> }) => {
  const outcome = await dismissMemberNotifications(session.user.id, body.ids, new Date());
  if (outcome === 'NOT_DISMISSABLE') {
    set.status = 400;
    return apiError('NOTIFICATION_NOT_DISMISSABLE', 'A penalty Notification cannot be dismissed.');
  }
  return apiSuccess();
};
