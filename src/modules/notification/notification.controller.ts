import type { AuthedContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import { CursorInputError } from '@/shared/cursor';

import type {
  NotificationDetailParams,
  NotificationListQuery,
  RegisterDeviceInput,
  UnregisterDeviceParams,
} from './notification.schema';
import {
  getUnreadNotificationCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  registerDevice,
  unregisterDevice,
} from './notification.service';

export const listNotificationsController = async ({
  query,
  session,
  set,
}: AuthedContext & { query: NotificationListQuery }) => {
  try {
    const result = await listNotifications(session.user.id, query);
    return apiSuccess(result);
  } catch (error) {
    if (error instanceof CursorInputError) {
      set.status = 400;
      return apiError(error.code, error.message);
    }
    throw error;
  }
};

export const getUnreadNotificationCountController = async ({ session }: AuthedContext) => {
  const unreadCount = await getUnreadNotificationCount(session.user.id);
  return apiSuccess({ unreadCount });
};

export const markNotificationReadController = async ({
  params,
  session,
  set,
}: AuthedContext & { params: NotificationDetailParams }) => {
  const result = await markNotificationRead(session.user.id, params.notificationId);
  if ('outcome' in result) {
    set.status = 404;
    return apiError('NOTIFICATION_NOT_FOUND', 'Notification not found');
  }
  return apiSuccess(result);
};

export const markAllNotificationsReadController = async ({ session }: AuthedContext) => {
  const result = await markAllNotificationsRead(session.user.id);
  return apiSuccess(result);
};

export const registerDeviceController = async ({
  body,
  session,
}: AuthedContext & { body: RegisterDeviceInput }) => {
  await registerDevice(session.user.id, body.token, body.platform ?? 'ANDROID');
  return apiSuccess({ registered: true as const });
};

export const unregisterDeviceController = async ({
  params,
  session,
}: AuthedContext & { params: UnregisterDeviceParams }) => {
  await unregisterDevice(session.user.id, params.token);
  return apiSuccess({ unregistered: true as const });
};
