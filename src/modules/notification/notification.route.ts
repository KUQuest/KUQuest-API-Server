import { authGuard, memberBanGuard } from '@/modules/auth';
import { apiSuccessSchema, betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { API_V1_PREFIX } from '@/shared/api-version';
import { rejectUnknownFields } from '@/shared/reject-unknown-fields';

import { Elysia } from 'elysia';

import {
  listNotificationsController,
  markNotificationsReadController,
  unreadNotificationCountController,
} from './notification.controller';
import {
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
  .use(memberBanGuard)
  .get('/', listNotificationsController, {
    query: listNotificationsQuerySchema,
    response: responses(notificationListResponseSchema, 400, 401, 403),
    detail: {
      tags: ['Notification'],
      summary: 'List Member Notifications',
      description:
        'Lists the authenticated Member inbox, newest first, with a cursor. It returns codes only, no localized text.',
      operationId: 'listMemberNotifications',
      security: betterAuthSecurity,
    },
  })
  .get('/unread-count', unreadNotificationCountController, {
    response: responses(notificationUnreadCountResponseSchema, 401, 403),
    detail: {
      tags: ['Notification'],
      summary: 'Count unread Member Notifications',
      description: 'Returns the number of unread Member Notifications of the authenticated Member.',
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
        'Marks the listed ids, or all unread rows, as read. Send exactly one of ids or all. A read row keeps its first readAt. Ids of other Members are ignored.',
      operationId: 'markMemberNotificationsRead',
      security: betterAuthSecurity,
    },
  });
