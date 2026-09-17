import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
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

import { authAdmin, authUser } from './auth.schema';
import {
  quest,
  questAssignment,
  questCandidateTeamV2,
  questV2ProofSubmission,
} from './quest.schema';

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
      table.requestKey
    ),
    index('admin_action_resource_idx').on(table.resourceType, table.resourceId, table.createdAt),
    index('admin_action_admin_created_idx').on(table.adminId, table.createdAt),
    index('admin_action_created_idx').on(table.createdAt, table.id),
    check('admin_action_action_check', sql`btrim(${table.action}) <> ''`),
    check('admin_action_resource_type_check', sql`btrim(${table.resourceType}) <> ''`),
    check('admin_action_resource_id_check', sql`btrim(${table.resourceId}) <> ''`),
    check('admin_action_request_key_check', sql`btrim(${table.requestKey}) <> ''`),
    check('admin_action_request_hash_check', sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
    check('admin_action_reason_catalog_version_check', sql`${table.reasonCatalogVersion} >= 1`),
    check(
      'admin_action_reason_code_check',
      sql`${table.reasonCode} IS NULL OR ${table.reasonCode} ~ '^[A-Z][A-Z0-9_.-]{0,99}$'`
    ),
    check(
      'admin_action_resource_version_check',
      sql`(${table.expectedVersion} IS NULL OR ${table.expectedVersion} >= 1) AND (${table.resultVersion} IS NULL OR ${table.resultVersion} >= 1)`
    ),
    check(
      'admin_action_resource_revision_check',
      sql`num_nonnulls(${table.expectedVersion}, ${table.expectedTimestamp}) <= 1 AND num_nonnulls(${table.resultVersion}, ${table.resultTimestamp}) <= 1`
    ),
    check('admin_action_metadata_object_check', sql`jsonb_typeof(${table.metadata}) = 'object'`),
    check(
      'admin_action_result_data_object_check',
      sql`jsonb_typeof(${table.resultData}) = 'object'`
    ),
  ]
);

/** Immutable system-created review evidence for a v2 Proof non-approval. */
export const adminReviewItem = pgTable(
  'admin_review_item',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    questId: uuid('quest_id')
      .notNull()
      .references(() => quest.id, { onDelete: 'cascade' }),
    assignmentId: uuid('assignment_id')
      .notNull()
      .references(() => questAssignment.id, { onDelete: 'cascade' }),
    proofSubmissionId: uuid('proof_submission_id')
      .notNull()
      .references(() => questV2ProofSubmission.id, { onDelete: 'cascade' }),
    hirerId: uuid('hirer_id')
      .notNull()
      .references(() => authUser.id),
    workerId: uuid('worker_id')
      .notNull()
      .references(() => authUser.id),
    teamId: uuid('team_id').references(() => questCandidateTeamV2.id),
    reason: varchar('reason', { length: 1000 }).notNull(),
    evidenceReferences: jsonb('evidence_references').$type<string[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('admin_review_item_proof_submission_key').on(table.proofSubmissionId),
    check('admin_review_item_reason_check', sql`btrim(${table.reason}) <> ''`),
    check(
      'admin_review_item_evidence_check',
      sql`jsonb_typeof(${table.evidenceReferences}) = 'array' AND jsonb_array_length(${table.evidenceReferences}) > 0`
    ),
    index('admin_review_item_quest_idx').on(table.questId, table.createdAt),
    index('admin_review_item_assignment_idx').on(table.assignmentId),
    index('admin_review_item_worker_idx').on(table.workerId),
  ]
);

export const disputeCaseStatus = {
  pending: 'DISPUTE_CASE_PENDING',
  dismissed: 'DISPUTE_CASE_DISMISSED',
  resolved: 'DISPUTE_CASE_RESOLVED',
} as const;
export const disputeCaseStatuses = [
  disputeCaseStatus.pending,
  disputeCaseStatus.dismissed,
  disputeCaseStatus.resolved,
] as const;
export type DisputeCaseStatus = (typeof disputeCaseStatuses)[number];

/** An Admin queue record for a payment dispute on a failed Quest. */
export const adminDisputeCase = pgTable(
  'admin_dispute_cases',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    questId: uuid('quest_id')
      .notNull()
      .references(() => quest.id, { onDelete: 'cascade' }),
    filerUserId: uuid('filer_user_id')
      .notNull()
      .references(() => authUser.id),
    openedByAdminId: uuid('opened_by_admin_id').references(() => authAdmin.id),
    status: text('status').$type<DisputeCaseStatus>().default('DISPUTE_CASE_PENDING').notNull(),
    version: integer('version').default(1).notNull(),
    resolvedWorkerId: uuid('resolved_worker_id').references(() => authUser.id),
    resolvedAmountSatang: integer('resolved_amount_satang'),
    resolvedByAdminId: uuid('resolved_by_admin_id').references(() => authAdmin.id),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('admin_dispute_cases_quest_filer_key').on(table.questId, table.filerUserId),
    index('admin_dispute_cases_status_created_idx').on(table.status, table.createdAt, table.id),
    index('admin_dispute_cases_quest_idx').on(table.questId, table.createdAt),
    index('admin_dispute_cases_filer_idx').on(table.filerUserId),
    check(
      'admin_dispute_cases_status_check',
      sql`${table.status} IN ('DISPUTE_CASE_PENDING', 'DISPUTE_CASE_DISMISSED', 'DISPUTE_CASE_RESOLVED')`
    ),
    check('admin_dispute_cases_version_check', sql`${table.version} >= 1`),
    check(
      'admin_dispute_cases_amount_check',
      sql`${table.resolvedAmountSatang} IS NULL OR ${table.resolvedAmountSatang} BETWEEN 1 AND 2000000000`
    ),
    check(
      'admin_dispute_cases_terminal_fields_check',
      sql`(
        (${table.status} = 'DISPUTE_CASE_PENDING' AND num_nonnulls(${table.resolvedWorkerId}, ${table.resolvedAmountSatang}, ${table.resolvedByAdminId}, ${table.resolvedAt}) = 0)
        OR (${table.status} = 'DISPUTE_CASE_DISMISSED' AND num_nonnulls(${table.resolvedWorkerId}, ${table.resolvedAmountSatang}) = 0 AND num_nonnulls(${table.resolvedByAdminId}, ${table.resolvedAt}) = 2)
        OR (${table.status} = 'DISPUTE_CASE_RESOLVED' AND num_nonnulls(${table.resolvedWorkerId}, ${table.resolvedAmountSatang}, ${table.resolvedByAdminId}, ${table.resolvedAt}) = 4)
      )`
    ),
  ]
);

export const conductReportReason = {
  abandoned: 'CONDUCT_ABANDONED',
  outOfScope: 'CONDUCT_OUT_OF_SCOPE',
  noShow: 'CONDUCT_NO_SHOW',
} as const;
export const conductReportReasons = [
  conductReportReason.abandoned,
  conductReportReason.outOfScope,
  conductReportReason.noShow,
] as const;
export type ConductReportReason = (typeof conductReportReasons)[number];

export const conductReportStatus = {
  pending: 'CONDUCT_REPORT_PENDING',
  upheld: 'CONDUCT_REPORT_UPHELD',
  dismissed: 'CONDUCT_REPORT_DISMISSED',
} as const;
export const conductReportStatuses = [
  conductReportStatus.pending,
  conductReportStatus.upheld,
  conductReportStatus.dismissed,
] as const;
export type ConductReportStatus = (typeof conductReportStatuses)[number];

/** A retained Admin review record for one Member's conduct on one Quest. */
export const adminConductReport = pgTable(
  'admin_conduct_reports',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    questId: uuid('quest_id')
      .notNull()
      .references(() => quest.id, { onDelete: 'restrict' }),
    filerUserId: uuid('filer_user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'restrict' }),
    reportedMemberId: uuid('reported_member_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'restrict' }),
    /** The Assignment used as the Quest record evidence for this report. */
    assignmentId: uuid('assignment_id').notNull(),
    reason: varchar('reason', { length: 64 }).$type<ConductReportReason>().notNull(),
    detail: text('detail'),
    status: text('status')
      .$type<ConductReportStatus>()
      .default(conductReportStatus.pending)
      .notNull(),
    version: integer('version').default(1).notNull(),
    decisionReason: varchar('decision_reason', { length: 1000 }),
    resolvedByAdminId: uuid('resolved_by_admin_id').references(() => authAdmin.id, {
      onDelete: 'restrict',
    }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('admin_conduct_reports_quest_reported_member_key').on(
      table.questId,
      table.reportedMemberId
    ),
    index('admin_conduct_reports_status_created_idx').on(table.status, table.createdAt, table.id),
    index('admin_conduct_reports_quest_created_idx').on(table.questId, table.createdAt, table.id),
    index('admin_conduct_reports_filer_created_idx').on(
      table.filerUserId,
      table.createdAt,
      table.id
    ),
    index('admin_conduct_reports_reported_member_created_idx').on(
      table.reportedMemberId,
      table.createdAt,
      table.id
    ),
    index('admin_conduct_reports_assignment_idx').on(table.assignmentId),
    foreignKey({
      name: 'admin_conduct_reports_assignment_context_fk',
      columns: [table.questId, table.assignmentId],
      foreignColumns: [questAssignment.questId, questAssignment.id],
    }).onDelete('restrict'),
    check(
      'admin_conduct_reports_reason_check',
      sql`${table.reason} IN ('CONDUCT_ABANDONED', 'CONDUCT_OUT_OF_SCOPE', 'CONDUCT_NO_SHOW')`
    ),
    check(
      'admin_conduct_reports_status_check',
      sql`${table.status} IN ('CONDUCT_REPORT_PENDING', 'CONDUCT_REPORT_UPHELD', 'CONDUCT_REPORT_DISMISSED')`
    ),
    check('admin_conduct_reports_version_check', sql`${table.version} >= 1`),
    check(
      'admin_conduct_reports_members_check',
      sql`${table.filerUserId} <> ${table.reportedMemberId}`
    ),
    check(
      'admin_conduct_reports_detail_check',
      sql`${table.detail} IS NULL OR btrim(${table.detail}) <> ''`
    ),
    check(
      'admin_conduct_reports_decision_reason_check',
      sql`${table.decisionReason} IS NULL OR btrim(${table.decisionReason}) <> ''`
    ),
    check(
      'admin_conduct_reports_resolution_check',
      sql`(
        (${table.status} = 'CONDUCT_REPORT_PENDING' AND num_nonnulls(${table.decisionReason}, ${table.resolvedByAdminId}, ${table.resolvedAt}) = 0)
        OR (${table.status} IN ('CONDUCT_REPORT_UPHELD', 'CONDUCT_REPORT_DISMISSED') AND num_nonnulls(${table.decisionReason}, ${table.resolvedByAdminId}, ${table.resolvedAt}) = 3)
      )`
    ),
    check(
      'admin_conduct_reports_resolved_after_created_check',
      sql`${table.resolvedAt} IS NULL OR ${table.resolvedAt} >= ${table.createdAt}`
    ),
  ]
);
