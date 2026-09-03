import {
  check,
  index,
  jsonb,
  pgTable,
  timestamp,
  varchar,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { authAdmin, authUser } from './auth.schema';

export const auditRecord = pgTable(
  'audit_record',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorType: varchar('actor_type', { length: 16 })
      .$type<'MEMBER' | 'SYSTEM' | 'ADMIN'>()
      .notNull(),
    actorUserId: uuid('actor_user_id').references(() => authUser.id),
    actorAdminId: uuid('actor_admin_id').references(() => authAdmin.id),
    action: varchar('action', { length: 64 }).notNull(),
    resourceType: varchar('resource_type', { length: 64 }).notNull(),
    resourceId: varchar('resource_id', { length: 200 }).notNull(),
    oldValue: jsonb('old_value').$type<Record<string, unknown> | null>(),
    newValue: jsonb('new_value').$type<Record<string, unknown> | null>(),
    reason: varchar('reason', { length: 1000 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      'audit_record_actor_check',
      sql`(${table.actorType} = 'SYSTEM' AND num_nonnulls(${table.actorUserId}, ${table.actorAdminId}) = 0) OR (${table.actorType} = 'MEMBER' AND ${table.actorUserId} IS NOT NULL AND ${table.actorAdminId} IS NULL) OR (${table.actorType} = 'ADMIN' AND ${table.actorUserId} IS NULL AND ${table.actorAdminId} IS NOT NULL)`,
    ),
    check('audit_record_action_check', sql`btrim(${table.action}) <> ''`),
    check('audit_record_resource_type_check', sql`btrim(${table.resourceType}) <> ''`),
    check('audit_record_resource_id_check', sql`btrim(${table.resourceId}) <> ''`),
    check(
      'audit_record_reason_check',
      sql`${table.reason} IS NULL OR btrim(${table.reason}) <> ''`,
    ),
    check(
      'audit_record_old_value_check',
      sql`${table.oldValue} IS NULL OR jsonb_typeof(${table.oldValue}) = 'object'`,
    ),
    check(
      'audit_record_new_value_check',
      sql`${table.newValue} IS NULL OR jsonb_typeof(${table.newValue}) = 'object'`,
    ),
    index('audit_record_resource_idx').on(table.resourceType, table.resourceId, table.createdAt),
    index('audit_record_created_idx').on(table.createdAt),
  ],
);
