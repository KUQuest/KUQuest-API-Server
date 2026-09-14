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
  uniqueIndex,
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
import {
  chatAttachment,
  chatMessage,
} from './work-chat.schema';

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
    index('admin_action_created_idx').on(table.createdAt, table.id),
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
      sql`jsonb_typeof(${table.evidenceReferences}) = 'array' AND jsonb_array_length(${table.evidenceReferences}) > 0`,
    ),
    index('admin_review_item_quest_idx').on(table.questId, table.createdAt),
    index('admin_review_item_assignment_idx').on(table.assignmentId),
    index('admin_review_item_worker_idx').on(table.workerId),
  ],
);

export const reportCaseStatus = {
  pending: 'REPORT_CASE_PENDING',
  dismissed: 'REPORT_CASE_DISMISSED',
  hidden: 'REPORT_CASE_HIDDEN',
  restored: 'REPORT_CASE_RESTORED',
} as const;
export const reportCaseStatuses = [
  reportCaseStatus.pending,
  reportCaseStatus.dismissed,
  reportCaseStatus.hidden,
  reportCaseStatus.restored,
] as const;
export type ReportCaseStatus = (typeof reportCaseStatuses)[number];

export const reporterEntryReason = {
  abusiveOrHarassment: 'REPORT_ABUSIVE_OR_HARASSMENT',
} as const;
export const reporterEntryReasons = [reporterEntryReason.abusiveOrHarassment] as const;
export type ReporterEntryReason = (typeof reporterEntryReasons)[number];

/** A Trust & Safety case that groups Reporter Entries for one Message. */
export const adminReportCase = pgTable(
  'admin_report_cases',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => chatMessage.id, { onDelete: 'restrict' }),
    status: text('status').$type<ReportCaseStatus>().default(reportCaseStatus.pending).notNull(),
    caseClosedAt: timestamp('case_closed_at', { withTimezone: true }),
    version: integer('version').default(1).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('admin_report_cases_id_message_key').on(table.id, table.messageId),
    uniqueIndex('admin_report_cases_one_open_message_uidx')
      .on(table.messageId)
      .where(sql`${table.status} IN ('REPORT_CASE_PENDING', 'REPORT_CASE_HIDDEN')`),
    index('admin_report_cases_status_created_idx').on(table.status, table.createdAt, table.id),
    index('admin_report_cases_message_created_idx').on(table.messageId, table.createdAt, table.id),
    check(
      'admin_report_cases_status_check',
      sql`${table.status} IN ('REPORT_CASE_PENDING', 'REPORT_CASE_DISMISSED', 'REPORT_CASE_HIDDEN', 'REPORT_CASE_RESTORED')`,
    ),
    check('admin_report_cases_version_check', sql`${table.version} >= 1`),
    check(
      'admin_report_cases_closed_time_check',
      sql`(
        (${table.status} IN ('REPORT_CASE_PENDING', 'REPORT_CASE_HIDDEN') AND ${table.caseClosedAt} IS NULL)
        OR (${table.status} IN ('REPORT_CASE_DISMISSED', 'REPORT_CASE_RESTORED') AND ${table.caseClosedAt} IS NOT NULL)
      )`,
    ),
    check(
      'admin_report_cases_closed_after_created_check',
      sql`${table.caseClosedAt} IS NULL OR ${table.caseClosedAt} >= ${table.createdAt}`,
    ),
  ],
);

/** A Member's reason and optional detail for one Message. */
export const adminReporterEntry = pgTable(
  'admin_reporter_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    reportCaseId: uuid('report_case_id').notNull(),
    messageId: uuid('message_id').notNull(),
    reporterMemberId: uuid('reporter_member_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'restrict' }),
    reason: varchar('reason', { length: 64 })
      .$type<ReporterEntryReason>()
      .notNull(),
    detail: text('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('admin_reporter_entries_message_reporter_key').on(
      table.messageId,
      table.reporterMemberId,
    ),
    foreignKey({
      name: 'admin_reporter_entries_case_message_fk',
      columns: [table.reportCaseId, table.messageId],
      foreignColumns: [adminReportCase.id, adminReportCase.messageId],
    }).onDelete('restrict'),
    check(
      'admin_reporter_entries_reason_check',
      sql`${table.reason} = 'REPORT_ABUSIVE_OR_HARASSMENT'`,
    ),
    check(
      'admin_reporter_entries_detail_check',
      sql`${table.detail} IS NULL OR btrim(${table.detail}) <> ''`,
    ),
    index('admin_reporter_entries_case_created_idx').on(table.reportCaseId, table.createdAt, table.id),
    index('admin_reporter_entries_reporter_idx').on(table.reporterMemberId, table.createdAt),
  ],
);

/** A case-scoped reference to retained Message or Attachment evidence. */
export const adminEvidenceReference = pgTable(
  'admin_evidence_references',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    reportCaseId: uuid('report_case_id')
      .notNull()
      .references(() => adminReportCase.id, { onDelete: 'restrict' }),
    messageId: uuid('message_id').references(() => chatMessage.id, { onDelete: 'restrict' }),
    attachmentId: uuid('attachment_id').references(() => chatAttachment.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('admin_evidence_references_case_message_uidx')
      .on(table.reportCaseId, table.messageId)
      .where(sql`${table.messageId} IS NOT NULL`),
    uniqueIndex('admin_evidence_references_case_attachment_uidx')
      .on(table.reportCaseId, table.attachmentId)
      .where(sql`${table.attachmentId} IS NOT NULL`),
    check(
      'admin_evidence_references_target_check',
      sql`num_nonnulls(${table.messageId}, ${table.attachmentId}) = 1`,
    ),
    index('admin_evidence_references_case_created_idx').on(table.reportCaseId, table.createdAt, table.id),
  ],
);

/** Immutable record of an Admin Report Case state decision. */
export const adminModerationDecision = pgTable(
  'admin_moderation_decisions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    reportCaseId: uuid('report_case_id')
      .notNull()
      .references(() => adminReportCase.id, { onDelete: 'restrict' }),
    adminId: uuid('admin_id')
      .notNull()
      .references(() => authAdmin.id, { onDelete: 'restrict' }),
    previousStatus: text('previous_status').$type<ReportCaseStatus>().notNull(),
    newStatus: text('new_status').$type<ReportCaseStatus>().notNull(),
    reasonCatalogVersion: integer('reason_catalog_version').notNull(),
    reasonCode: varchar('reason_code', { length: 100 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      'admin_moderation_decisions_transition_check',
      sql`(
        (${table.previousStatus} = 'REPORT_CASE_PENDING' AND ${table.newStatus} IN ('REPORT_CASE_DISMISSED', 'REPORT_CASE_HIDDEN'))
        OR (${table.previousStatus} = 'REPORT_CASE_HIDDEN' AND ${table.newStatus} IN ('REPORT_CASE_DISMISSED', 'REPORT_CASE_HIDDEN', 'REPORT_CASE_RESTORED'))
      )`,
    ),
    check(
      'admin_moderation_decisions_reason_catalog_version_check',
      sql`${table.reasonCatalogVersion} >= 1`,
    ),
    check(
      'admin_moderation_decisions_reason_code_check',
      sql`${table.reasonCode} ~ '^[A-Z][A-Z0-9_.-]{0,99}$'`,
    ),
    index('admin_moderation_decisions_case_created_idx').on(table.reportCaseId, table.createdAt, table.id),
    index('admin_moderation_decisions_admin_created_idx').on(table.adminId, table.createdAt),
  ],
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
    check('admin_dispute_cases_status_check', sql`${table.status} IN ('DISPUTE_CASE_PENDING', 'DISPUTE_CASE_DISMISSED', 'DISPUTE_CASE_RESOLVED')`),
    check('admin_dispute_cases_version_check', sql`${table.version} >= 1`),
    check('admin_dispute_cases_amount_check', sql`${table.resolvedAmountSatang} IS NULL OR ${table.resolvedAmountSatang} BETWEEN 1 AND 2000000000`),
    check(
      'admin_dispute_cases_terminal_fields_check',
      sql`(
        (${table.status} = 'DISPUTE_CASE_PENDING' AND num_nonnulls(${table.resolvedWorkerId}, ${table.resolvedAmountSatang}, ${table.resolvedByAdminId}, ${table.resolvedAt}) = 0)
        OR (${table.status} = 'DISPUTE_CASE_DISMISSED' AND num_nonnulls(${table.resolvedWorkerId}, ${table.resolvedAmountSatang}) = 0 AND num_nonnulls(${table.resolvedByAdminId}, ${table.resolvedAt}) = 2)
        OR (${table.status} = 'DISPUTE_CASE_RESOLVED' AND num_nonnulls(${table.resolvedWorkerId}, ${table.resolvedAmountSatang}, ${table.resolvedByAdminId}, ${table.resolvedAt}) = 4)
      )`,
    ),
  ],
);
