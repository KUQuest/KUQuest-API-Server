export { notificationRoute } from './notification.route';
export {
  createNotification,
  listNotifications,
  getUnreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
  registerDevice,
  unregisterDevice,
} from './notification.service';
export type { CreateNotificationInput } from './notification.service';
export * from './notification.schema';
