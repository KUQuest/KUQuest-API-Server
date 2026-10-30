import { authGuard } from '@/modules/auth';
import { apiSuccessSchema, betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { API_V1_PREFIX } from '@/shared/api-version';
import { rejectUnknownFields } from '@/shared/reject-unknown-fields';

import { Elysia } from 'elysia';

import {
  dismissNotificationsController,
  listNotificationsController,
  markNotificationsReadController,
  unreadNotificationCountController,
} from './notification.controller';
import {
  dismissNotificationsSchema,
  listNotificationsQuerySchema,
  markNotificationsReadSchema,
  notificationListResponseSchema,
  notificationUnreadCountResponseSchema,
} from './notification.schema';

export const notificationRoute = new Elysia({
  name: 'notification-route',
  prefix: `${API_V1_PREFIX}/notifications`,
})
  .use(authGuard)
  // No memberBanGuard: a banned Member still reads and clears their own inbox, so the Member can
  // see the ban Notification.
  .get('/', listNotificationsController, {
    query: listNotificationsQuerySchema,
    response: responses(notificationListResponseSchema, 400, 401, 403),
    detail: {
      tags: ['Notification'],
      summary: 'List Member Notifications',
      description:
        'Lists the authenticated Member inbox, newest first, with a cursor. It returns codes only, no localized text. A dismissed row is hidden. Filter with category: PENALTY, QUEST, or DISPUTE. Repeat category to combine. A banned Member can call this route.',
      operationId: 'listMemberNotifications',
      security: betterAuthSecurity,
    },
  })
  .get('/unread-count', unreadNotificationCountController, {
    response: responses(notificationUnreadCountResponseSchema, 401, 403),
    detail: {
      tags: ['Notification'],
      summary: 'Count unread Member Notifications',
      description:
        'Returns the number of unread, not dismissed Member Notifications, in total and by category. A banned Member can call this route.',
      operationId: 'countUnreadMemberNotifications',
      security: betterAuthSecurity,
    },
  })
  .post('/read', markNotificationsReadController, {
    body: markNotificationsReadSchema,
    transform: rejectUnknownFields(markNotificationsReadSchema),
    response: responses(apiSuccessSchema, 400, 401, 403),
    detail: {
      tags: ['Notification'],
      summary: 'Mark Member Notifications as read',
      description:
        'Marks the listed ids, or all unread rows, as read. Send exactly one of ids or all. Send category only with all, to read one category. A read row keeps its first readAt. Ids of other Members are ignored. A banned Member can call this route.',
      operationId: 'markMemberNotificationsRead',
      security: betterAuthSecurity,
    },
  })
  .post('/dismiss', dismissNotificationsController, {
    body: dismissNotificationsSchema,
    transform: rejectUnknownFields(dismissNotificationsSchema),
    response: responses(apiSuccessSchema, 400, 401, 403),
    detail: {
      tags: ['Notification'],
      summary: 'Dismiss Member Notifications',
      description:
        'Hides the listed rows from the inbox and marks them read. A penalty row cannot be dismissed: the request fails with NOTIFICATION_NOT_DISMISSABLE and changes nothing. Dismiss is idempotent. Ids of other Members are ignored. A banned Member can call this route.',
      operationId: 'dismissMemberNotifications',
      security: betterAuthSecurity,
    },
  });
