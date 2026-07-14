import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, inet, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth.schema';

const time = (name: string) => timestamp(name, { withTimezone: true });
const id = () => uuid('id').defaultRandom().primaryKey();
const satang = (name: string) => bigint(name, { mode: 'bigint' });

export const providerWebhookEvents = pgTable('provider_webhook_events', { id: id(), provider: text('provider').notNull(), providerEventId: text('provider_event_id').notNull(), kind: text('kind').notNull(), authenticatedAt: time('authenticated_at').notNull(), payload: jsonb('payload').notNull(), payloadHash: text('payload_hash').notNull(), status: text('status').default('RECEIVED').notNull(), attempts: integer('attempts').default(0).notNull(), receivedAt: time('received_at').defaultNow().notNull(), claimedAt: time('claimed_at'), processedAt: time('processed_at'), lastError: text('last_error') }, (t) => [unique('provider_webhook_provider_event_uq').on(t.provider, t.providerEventId), index('provider_webhook_claim_idx').on(t.status, t.receivedAt), check('provider_webhook_attempts_chk', sql`${t.attempts} >= 0`)]);
export const providerWebhookEventStatusHistory = pgTable('provider_webhook_event_status_history', { id: id(), eventId: uuid('event_id').notNull().references(() => providerWebhookEvents.id), fromStatus: text('from_status'), toStatus: text('to_status').notNull(), reason: text('reason'), error: text('error'), occurredAt: time('occurred_at').defaultNow().notNull() }, (t) => [index('provider_webhook_history_idx').on(t.eventId, t.occurredAt)]);

export const reconciliationRuns = pgTable('reconciliation_runs', { id: id(), provider: text('provider').notNull(), periodStart: time('period_start').notNull(), periodEnd: time('period_end').notNull(), internalTotalSatang: satang('internal_total_satang').notNull(), providerTotalSatang: satang('provider_total_satang').notNull(), differenceSatang: satang('difference_satang').notNull(), status: text('status').notNull(), startedByUserId: text('started_by_user_id').references(() => user.id), startedAt: time('started_at').defaultNow().notNull(), completedAt: time('completed_at') }, (t) => [check('reconciliation_period_chk', sql`${t.periodEnd} > ${t.periodStart}`)]);
export const reconciliationItems = pgTable('reconciliation_items', { id: id(), runId: uuid('run_id').notNull().references(() => reconciliationRuns.id), type: text('type').notNull(), reference: text('reference').notNull(), expectedSatang: satang('expected_satang').notNull(), actualSatang: satang('actual_satang').notNull(), differenceSatang: satang('difference_satang').notNull(), status: text('status').notNull(), notes: text('notes') }, (t) => [index('reconciliation_items_run_idx').on(t.runId, t.status)]);

export const platformControls = pgTable('platform_controls', { key: text('key').primaryKey(), outboundMoneyHeld: boolean('outbound_money_held').default(false).notNull(), reconciliationRunId: uuid('reconciliation_run_id').references(() => reconciliationRuns.id), reason: text('reason'), changedByUserId: text('changed_by_user_id').references(() => user.id), createdAt: time('created_at').defaultNow().notNull(), updatedAt: time('updated_at').defaultNow().notNull() });

export const scheduledTasks = pgTable('scheduled_tasks', { id: id(), type: text('type').notNull(), dedupeKey: text('dedupe_key').notNull().unique(), aggregateType: text('aggregate_type'), aggregateId: text('aggregate_id'), runAt: time('run_at').notNull(), payload: jsonb('payload').default({}).notNull(), status: text('status').default('PENDING').notNull(), attempts: integer('attempts').default(0).notNull(), maxAttempts: integer('max_attempts').default(10).notNull(), lockedBy: text('locked_by'), lockedAt: time('locked_at'), leaseExpiresAt: time('lease_expires_at'), lastError: text('last_error'), createdAt: time('created_at').defaultNow().notNull(), updatedAt: time('updated_at').defaultNow().notNull() }, (t) => [index('scheduled_tasks_claim_idx').on(t.status, t.runAt), check('scheduled_tasks_attempts_chk', sql`${t.attempts} >= 0 and ${t.maxAttempts} > 0 and ${t.attempts} <= ${t.maxAttempts}`)]);
export const scheduledTaskStatusHistory = pgTable('scheduled_task_status_history', { id: id(), taskId: uuid('task_id').notNull().references(() => scheduledTasks.id), fromStatus: text('from_status'), toStatus: text('to_status').notNull(), source: text('source').notNull(), reason: text('reason'), error: text('error'), occurredAt: time('occurred_at').defaultNow().notNull() }, (t) => [index('scheduled_task_history_idx').on(t.taskId, t.occurredAt)]);

export const auditEvents = pgTable('audit_events', { id: id(), actorUserId: text('actor_user_id').references(() => user.id), source: text('source').notNull(), action: text('action').notNull(), resourceType: text('resource_type').notNull(), resourceId: text('resource_id'), reason: text('reason'), before: jsonb('before'), after: jsonb('after'), requestId: text('request_id'), traceId: text('trace_id'), ipAddress: inet('ip_address'), occurredAt: time('occurred_at').defaultNow().notNull() }, (t) => [index('audit_events_resource_idx').on(t.resourceType, t.resourceId, t.occurredAt), index('audit_events_actor_idx').on(t.actorUserId, t.occurredAt)]);

export const developmentTestUsers = pgTable('development_test_users', {
  userId: text('user_id').primaryKey().references(() => user.id),
  createdByUserId: text('created_by_user_id').notNull().references(() => user.id),
  createdAt: time('created_at').defaultNow().notNull(),
}, (t) => [index('development_test_users_created_by_idx').on(t.createdByUserId, t.createdAt)]);

export const developmentActorSessions = pgTable('development_actor_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id),
  activatedByUserId: text('activated_by_user_id').notNull().references(() => user.id),
  expiresAt: time('expires_at').notNull(),
  createdAt: time('created_at').defaultNow().notNull(),
}, (t) => [
  index('development_actor_sessions_user_idx').on(t.userId),
  index('development_actor_sessions_expiry_idx').on(t.expiresAt),
]);
