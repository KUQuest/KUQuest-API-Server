import { sql } from 'drizzle-orm';
import { check, index, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { authUser } from './auth.schema';

/**
 * Member Notification inbox. One row per Member and Event.
 * It stores codes only: no localized text, reporter identity, Message text, or Proof.
 */
export const memberNotification = pgTable(
  'member_notifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 64 }).notNull(),
    eventKey: varchar('event_key', { length: 200 }).notNull(),
    questId: uuid('quest_id'),
    result: varchar('result', { length: 32 }),
    ladder: varchar('ladder', { length: 16 }),
    source: varchar('source', { length: 32 }),
    transitionId: varchar('transition_id', { length: 200 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('member_notifications_member_event_uidx').on(table.memberId, table.eventKey),
    index('member_notifications_member_newest_idx').on(
      table.memberId,
      sql`${table.createdAt} desc`,
      sql`${table.id} desc`
    ),
    index('member_notifications_member_unread_idx')
      .on(table.memberId)
      .where(sql`${table.readAt} is null`),
    check('member_notifications_event_key_check', sql`btrim(${table.eventKey}) <> ''`),
    check(
      'member_notifications_type_check',
      sql`${table.type} IN ('PENALTY_RED_FLAG_APPLIED', 'PENALTY_RED_FLAG_EXPIRED', 'PENALTY_BAN_APPLIED', 'PENALTY_BAN_ENDED', 'CONDUCT_REPORT_UPHELD')`
    ),
    check(
      'member_notifications_result_check',
      sql`${table.result} IS NULL OR ${table.result} IN ('RED_FLAG', 'TEMPORARY_BAN', 'PERMANENT_BAN')`
    ),
    check(
      'member_notifications_ladder_check',
      sql`${table.ladder} IS NULL OR ${table.ladder} IN ('MISCONDUCT', 'REVIEW')`
    ),
    check(
      'member_notifications_source_check',
      sql`${table.source} IS NULL OR ${table.source} IN ('REPORT_CASE', 'CONDUCT_REPORT', 'REVIEW_AVERAGE')`
    ),
  ]
);
