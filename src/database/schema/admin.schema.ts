import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { authAdmin } from './auth.schema';

export const adminAction = pgTable(
  'admin_action',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    adminId: uuid('admin_id')
      .notNull()
      .references(() => authAdmin.id, { onDelete: 'restrict' }),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    requestKey: text('request_key').notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    reasonCatalogVersion: integer('reason_catalog_version').notNull(),
    reasonCode: text('reason_code'),
    expectedVersion: integer('expected_version'),
    expectedTimestamp: timestamp('expected_timestamp', { withTimezone: true }),
    resultVersion: integer('result_version'),
    resultTimestamp: timestamp('result_timestamp', { withTimezone: true }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull(),
    resultData: jsonb('result_data').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('admin_action_admin_action_request_key').on(
      table.adminId,
      table.action,
      table.requestKey,
    ),
    index('admin_action_resource_idx').on(table.resourceType, table.resourceId, table.createdAt),
    index('admin_action_admin_created_idx').on(table.adminId, table.createdAt),
    check('admin_action_action_check', sql`btrim(${table.action}) <> ''`),
    check('admin_action_resource_type_check', sql`btrim(${table.resourceType}) <> ''`),
    check('admin_action_resource_id_check', sql`btrim(${table.resourceId}) <> ''`),
    check('admin_action_request_key_check', sql`btrim(${table.requestKey}) <> ''`),
    check('admin_action_request_hash_check', sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'admin_action_reason_catalog_version_check',
      sql`${table.reasonCatalogVersion} >= 1`,
    ),
    check(
      'admin_action_reason_code_check',
      sql`${table.reasonCode} IS NULL OR ${table.reasonCode} ~ '^[A-Z][A-Z0-9_.-]{0,99}$'`,
    ),
    check(
      'admin_action_resource_version_check',
      sql`(${table.expectedVersion} IS NULL OR ${table.expectedVersion} >= 1) AND (${table.resultVersion} IS NULL OR ${table.resultVersion} >= 1)`,
    ),
    check(
      'admin_action_resource_revision_check',
      sql`num_nonnulls(${table.expectedVersion}, ${table.expectedTimestamp}) <= 1 AND num_nonnulls(${table.resultVersion}, ${table.resultTimestamp}) <= 1`,
    ),
    check('admin_action_metadata_object_check', sql`jsonb_typeof(${table.metadata}) = 'object'`),
    check('admin_action_result_data_object_check', sql`jsonb_typeof(${table.resultData}) = 'object'`),
  ],
);
