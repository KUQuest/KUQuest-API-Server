import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

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
    questTitle: varchar('quest_title', { length: 200 }),
    actorRole: varchar('actor_role', { length: 16 }),
    cancellationReason: varchar('cancellation_reason', { length: 32 }),
    failureReason: varchar('failure_reason', { length: 32 }),
    /** No foreign key: the row outlives the Assignment and the Dispute Case. */
    assignmentId: uuid('assignment_id'),
    disputeCaseId: uuid('dispute_case_id'),
    disputeStatus: varchar('dispute_status', { length: 32 }),
    viewerWon: boolean('viewer_won'),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('member_notifications_member_event_uidx').on(table.memberId, table.eventKey),
    index('member_notifications_member_newest_idx')
      .on(table.memberId, sql`${table.createdAt} desc`, sql`${table.id} desc`)
      .where(sql`${table.dismissedAt} is null`),
    index('member_notifications_member_unread_idx')
      .on(table.memberId)
      .where(sql`${table.readAt} is null and ${table.dismissedAt} is null`),
    check('member_notifications_event_key_check', sql`btrim(${table.eventKey}) <> ''`),
    check(
      'member_notifications_type_check',
      sql`${table.type} IN ('PENALTY_RED_FLAG_APPLIED', 'PENALTY_RED_FLAG_EXPIRED', 'PENALTY_BAN_APPLIED', 'PENALTY_BAN_ENDED', 'CONDUCT_REPORT_UPHELD', 'UNDERFILLED_DECISION_PENDING', 'UNDERFILLED_CONSENT_PENDING', 'UNDERFILLED_COMPLETED', 'UNDERFILLED_CANCELLED', 'QUEST_ASSIGNED', 'PROOF_NOT_APPROVED', 'QUEST_COMPLETED_DISPUTE_WINDOW_OPEN', 'QUEST_FAILED', 'DISPUTE_CASE_FILED_AGAINST_YOU', 'DISPUTE_CASE_DECIDED')`
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
    check(
      'member_notifications_actor_role_check',
      sql`${table.actorRole} IS NULL OR ${table.actorRole} IN ('HIRER', 'WORKER')`
    ),
    check(
      'member_notifications_cancellation_reason_check',
      sql`${table.cancellationReason} IS NULL OR ${table.cancellationReason} IN ('HIRER_CANCELLED', 'HIRER_NO_DECISION', 'WORKER_DECLINED', 'CONSENT_TIMEOUT')`
    ),
    check(
      'member_notifications_failure_reason_check',
      sql`${table.failureReason} IS NULL OR ${table.failureReason} IN ('PROOF_NOT_APPROVED', 'COMPLETION_NOT_APPROVED', 'DUE_AT_MISSED')`
    ),
    check(
      'member_notifications_dispute_status_check',
      sql`${table.disputeStatus} IS NULL OR ${table.disputeStatus} IN ('DISPUTE_CASE_DISMISSED', 'DISPUTE_CASE_RESOLVED')`
    ),
  ]
);
