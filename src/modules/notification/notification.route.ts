import { authGuard } from '@/modules/auth';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { API_V2_PREFIX } from '@/shared/api-version';

import { Elysia } from 'elysia';

import {
  getUnreadNotificationCountController,
  listNotificationsController,
  markAllNotificationsReadController,
  markNotificationReadController,
  registerDeviceController,
  unregisterDeviceController,
} from './notification.controller';
import {
  notificationDetailParamsSchema,
  notificationListQuerySchema,
  notificationListResponseSchema,
  notificationMarkAllReadResponseSchema,
  notificationReadResponseSchema,
  notificationUnreadCountResponseSchema,
  registerDeviceBodySchema,
  registerDeviceResponseSchema,
  unregisterDeviceParamsSchema,
  unregisterDeviceResponseSchema,
} from './notification.schema';

export const notificationRoute = new Elysia({
  name: 'notification-route',
  prefix: `${API_V2_PREFIX}/notifications`,
})
  .use(authGuard)
  .get('', listNotificationsController, {
    query: notificationListQuerySchema,
    response: responses(notificationListResponseSchema, 400, 401),
    detail: {
      tags: ['Notifications'],
      summary: 'List user notifications',
      description: 'Returns paginated notifications for the authenticated user.',
      operationId: 'listNotifications',
      security: betterAuthSecurity,
    },
  })
  .get('/unread-count', getUnreadNotificationCountController, {
    response: responses(notificationUnreadCountResponseSchema, 401),
    detail: {
      tags: ['Notifications'],
      summary: 'Get unread notification count',
      description: 'Returns the count of unread notifications for badge display.',
      operationId: 'getUnreadNotificationCount',
      security: betterAuthSecurity,
    },
  })
  .patch('/:notificationId/read', markNotificationReadController, {
    params: notificationDetailParamsSchema,
    response: responses(notificationReadResponseSchema, 401, 404),
    detail: {
      tags: ['Notifications'],
      summary: 'Mark notification as read',
      operationId: 'markNotificationRead',
      security: betterAuthSecurity,
    },
  })
  .post('/mark-all-read', markAllNotificationsReadController, {
    response: responses(notificationMarkAllReadResponseSchema, 401),
    detail: {
      tags: ['Notifications'],
      summary: 'Mark all notifications as read',
      operationId: 'markAllNotificationsRead',
      security: betterAuthSecurity,
    },
  })
  .post('/devices', registerDeviceController, {
    body: registerDeviceBodySchema,
    response: responses(registerDeviceResponseSchema, 400, 401),
    detail: {
      tags: ['Notifications'],
      summary: 'Register FCM device token for push notifications',
      operationId: 'registerNotificationDevice',
      security: betterAuthSecurity,
    },
  })
  .delete('/devices/:token', unregisterDeviceController, {
    params: unregisterDeviceParamsSchema,
    response: responses(unregisterDeviceResponseSchema, 401),
    detail: {
      tags: ['Notifications'],
      summary: 'Unregister FCM device token',
      operationId: 'unregisterNotificationDevice',
      security: betterAuthSecurity,
    },
  });
