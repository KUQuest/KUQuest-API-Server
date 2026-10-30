import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { authUser } from './auth.schema';

export const pushDeliveryStatuses = [
  'PUSH_DELIVERY_PENDING',
  'PUSH_DELIVERY_DELIVERED',
  'PUSH_DELIVERY_FAILED',
  'PUSH_DELIVERY_DISABLED',
] as const;
export type PushDeliveryStatus = (typeof pushDeliveryStatuses)[number];

export const pushDevice = pgTable(
  'push_devices',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    keyVersion: varchar('key_version', { length: 32 }).notNull(),
    nonce: varchar('nonce', { length: 32 }).notNull(),
    ciphertext: text('ciphertext').notNull(),
    authTag: varchar('auth_tag', { length: 32 }).notNull(),
    registeredAt: timestamp('registered_at', { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('push_devices_token_hash_uidx').on(table.tokenHash),
    index('push_devices_member_active_idx').on(table.memberId, table.disabledAt),
    check('push_devices_token_hash_check', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check('push_devices_key_version_check', sql`btrim(${table.keyVersion}) <> ''`),
  ]
);

export const pushDelivery = pgTable(
  'push_deliveries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    recipientMemberId: uuid('recipient_member_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    eventKey: varchar('event_key', { length: 200 }).notNull(),
    eventType: varchar('event_type', { length: 100 }).notNull(),
    title: varchar('title', { length: 120 }).notNull(),
    body: varchar('body', { length: 500 }).notNull(),
    deepLink: varchar('deep_link', { length: 500 }).notNull(),
    data: jsonb('data').$type<Record<string, string>>().notNull().default({}),
    status: varchar('status', { length: 32 })
      .$type<PushDeliveryStatus>()
      .notNull()
      .default('PUSH_DELIVERY_PENDING'),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    lastErrorCode: varchar('last_error_code', { length: 100 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('push_deliveries_recipient_event_uidx').on(table.recipientMemberId, table.eventKey),
    index('push_deliveries_pending_idx').on(table.status, table.nextAttemptAt, table.createdAt),
    check('push_deliveries_event_key_check', sql`btrim(${table.eventKey}) <> ''`),
    check('push_deliveries_event_type_check', sql`btrim(${table.eventType}) <> ''`),
    check(
      'push_deliveries_status_check',
      sql`${table.status} IN ('PUSH_DELIVERY_PENDING', 'PUSH_DELIVERY_DELIVERED', 'PUSH_DELIVERY_FAILED', 'PUSH_DELIVERY_DISABLED')`
    ),
    check('push_deliveries_attempt_count_check', sql`${table.attemptCount} >= 0`),
    check('push_deliveries_data_object_check', sql`jsonb_typeof(${table.data}) = 'object'`),
  ]
);
