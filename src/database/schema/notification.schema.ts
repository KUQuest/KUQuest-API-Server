import { relations } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { authUser } from './auth.schema';

const time = (name: string) => timestamp(name, { withTimezone: true });

export const notification = pgTable(
  'notification',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => authUser.id, { onDelete: 'set null' }),
    category: text('category').notNull(),
    type: text('type').notNull(),
    severity: text('severity').notNull().default('info'),
    title: text('title').notNull(),
    message: text('message').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: uuid('resource_id').notNull(),
    actionRoute: text('action_route').notNull(),
    actionLabel: text('action_label').notNull(),
    readAt: time('read_at'),
    createdAt: time('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('notification_recipient_id_read_at_idx').on(table.recipientId, table.readAt),
    index('notification_recipient_id_created_at_idx').on(table.recipientId, table.createdAt),
  ]
);

export const notificationDevice = pgTable(
  'notification_device',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    platform: text('platform').notNull().default('ANDROID'),
    createdAt: time('created_at').defaultNow().notNull(),
    updatedAt: time('updated_at').defaultNow().notNull(),
  },
  (table) => [index('notification_device_member_id_idx').on(table.memberId)]
);

export const notificationRelations = relations(notification, ({ one }) => ({
  recipient: one(authUser, {
    fields: [notification.recipientId],
    references: [authUser.id],
    relationName: 'notification_recipient',
  }),
  actor: one(authUser, {
    fields: [notification.actorId],
    references: [authUser.id],
    relationName: 'notification_actor',
  }),
}));

export const notificationDeviceRelations = relations(notificationDevice, ({ one }) => ({
  member: one(authUser, {
    fields: [notificationDevice.memberId],
    references: [authUser.id],
  }),
}));

export type NotificationRow = typeof notification.$inferSelect;
export type NewNotificationRow = typeof notification.$inferInsert;
export type NotificationDeviceRow = typeof notificationDevice.$inferSelect;
export type NewNotificationDeviceRow = typeof notificationDevice.$inferInsert;
