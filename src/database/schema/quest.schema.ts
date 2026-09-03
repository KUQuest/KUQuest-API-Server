import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { authAdmin, authUser } from './auth.schema';
import { file } from './file.schema';
import { tag } from './tag.schema';
import { paymentMoneyPolicyRevision, walletFundingReservation } from './wallet.schema';

const time = (name: string) => timestamp(name, { withTimezone: true });

export const questMode = pgEnum('quest_mode', ['NO_CANDIDATE', 'CANDIDATE']);
export const questParticipation = pgEnum('quest_participation', ['SOLO', 'GROUP']);
export const questApiVersion = {
  v1: 'v1',
  v2: 'v2',
} as const;
export type QuestApiVersion = (typeof questApiVersion)[keyof typeof questApiVersion];

export const questStatus = pgEnum('quest_status', [
  'QUEST_DRAFT',
  'QUEST_OPEN',
  'QUEST_AWAITING_CONSENT',
  'QUEST_ASSIGNED',
  'QUEST_IN_PROGRESS',
  'QUEST_SUBMITTED',
  'QUEST_APPROVED',
  'QUEST_REWORK',
  'QUEST_COMPLETED',
  'QUEST_CANCELLED',
  'QUEST_DISPUTED',
  'QUEST_FAILED',
]);

export const quest = pgTable(
  'quest',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    hirerId: uuid('hirer_id')
      .notNull()
      .references(() => authUser.id),
    apiVersion: varchar('api_version', { length: 2 })
      .$type<QuestApiVersion>()
      .default(questApiVersion.v1)
      .notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    description: varchar('description', { length: 2000 }),
    condition: varchar('condition', { length: 4000 }).notNull(),
    mode: questMode('mode').notNull(),
    participation: questParticipation('participation').default('SOLO').notNull(),
    v2Mode: varchar('v2_mode', { length: 32 }).$type<
      'FIRST_COME_FIRST_SERVED' | 'CANDIDATE'
    >(),
    v2Participation: varchar('v2_participation', { length: 16 }).$type<
      'SINGLE' | 'GROUP'
    >(),
    questStatus: questStatus('quest_status').default('QUEST_DRAFT').notNull(),
    version: integer('version').default(1).notNull(),
    rewardSatang: integer('reward_satang'),
    questFundingTotalSatang: integer('quest_funding_total_satang'),
    fundingReservationId: uuid('funding_reservation_id')
      .unique()
      .references(() => walletFundingReservation.id),
    policyRevisionId: uuid('policy_revision_id').references(() => paymentMoneyPolicyRevision.id),
    platformFeeBps: smallint('platform_fee_bps'),
    platformFeePerWorkerSatang: integer('platform_fee_per_worker_satang'),
    questEscrowSatang: integer('quest_escrow_satang'),
    tagId: uuid('tag_id').references(() => tag.id),
    headcount: integer('headcount').default(1).notNull(),
    startTime: time('start_time').notNull(),
    dueAt: time('due_at'),
    proofRequired: boolean('proof_required').default(true).notNull(),
    cancelledAt: time('cancelled_at'),
    cancelledByUserId: uuid('cancelled_by_user_id').references(() => authUser.id),
    cancelledByAdminId: uuid('cancelled_by_admin_id').references(() => authAdmin.id),
    hiddenAt: time('hidden_at'),
    hiddenByAdminId: uuid('hidden_by_admin_id').references(() => authAdmin.id),
    createdAt: time('created_at').defaultNow().notNull(),
    updatedAt: time('updated_at').defaultNow().notNull(),
  },
  (table) => [
    check('quest_api_version_check', sql`${table.apiVersion} IN ('v1', 'v2')`),
    check(
      'quest_v2_mode_check',
      sql`${table.v2Mode} IS NULL OR ${table.v2Mode} IN ('FIRST_COME_FIRST_SERVED', 'CANDIDATE')`,
    ),
    check(
      'quest_v2_participation_check',
      sql`${table.v2Participation} IS NULL OR ${table.v2Participation} IN ('SINGLE', 'GROUP')`,
    ),
    check('quest_version_check', sql`${table.version} >= 1`),
    check(
      'quest_funding_total_check',
      sql`${table.questFundingTotalSatang} IS NULL OR ${table.questFundingTotalSatang} BETWEEN 100 AND 70000000`,
    ),
    check('quest_reward_check', sql`${table.rewardSatang} IS NULL OR ${table.rewardSatang} > 0`),
    check(
      'quest_v2_draft_reward_check',
      sql`${table.apiVersion} <> 'v2' OR ${table.questStatus} <> 'QUEST_DRAFT' OR ${table.rewardSatang} IS NULL`,
    ),
    check(
      'quest_reward_required_check',
      sql`(${table.apiVersion} = 'v2' AND ${table.questStatus} = 'QUEST_DRAFT') OR ${table.rewardSatang} IS NOT NULL`,
    ),
    check('quest_finance_snapshot_bps_check', sql`${table.platformFeeBps} IS NULL OR ${table.platformFeeBps} BETWEEN 0 AND 10000`),
    check('quest_finance_snapshot_amounts_check', sql`${table.platformFeePerWorkerSatang} IS NULL OR ${table.platformFeePerWorkerSatang} >= 0`),
    check('quest_finance_snapshot_escrow_check', sql`${table.questEscrowSatang} IS NULL OR ${table.questEscrowSatang} > 0`),
    check('quest_headcount_check', sql`${table.headcount} > 0`),
    check(
      'quest_participation_headcount_check',
      sql`(
        ${table.apiVersion} <> 'v2' AND
        (${table.participation} = 'GROUP' OR ${table.headcount} = 1)
      ) OR (
        ${table.apiVersion} = 'v2' AND
        ${table.v2Participation} IS NOT NULL AND
        (
          (${table.v2Participation} = 'SINGLE' AND ${table.headcount} = 1) OR
          (${table.v2Participation} = 'GROUP' AND ${table.headcount} BETWEEN 2 AND 20)
        )
      )`,
    ),
    check('quest_due_at_check', sql`${table.dueAt} IS NULL OR ${table.dueAt} > ${table.startTime}`),
    check(
      'quest_tag_check',
      sql`${table.questStatus} IN ('QUEST_DRAFT', 'QUEST_CANCELLED') OR ${table.tagId} IS NOT NULL`,
    ),
    check(
      'quest_cancelled_by_check',
      sql`num_nonnulls(${table.cancelledByUserId}, ${table.cancelledByAdminId}) <= 1`,
    ),
    check(
      'quest_cancelled_at_check',
      sql`(${table.cancelledAt} IS NULL) = (${table.questStatus} <> 'QUEST_CANCELLED')`,
    ),
    check(
      'quest_hidden_by_check',
      sql`(${table.hiddenByAdminId} IS NULL) = (${table.hiddenAt} IS NULL)`,
    ),
    index('quest_hirer_id_idx').on(table.hirerId),
    index('quest_status_idx').on(table.questStatus),
    index('quest_mode_idx').on(table.mode),
    index('quest_tag_id_idx').on(table.tagId),
    index('quest_start_time_idx').on(table.startTime),
  ],
);

export const questConditionItem = pgTable(
  'quest_condition_item',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    questId: uuid('quest_id')
      .notNull()
      .references(() => quest.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    text: varchar('text', { length: 255 }).notNull(),
  },
  (table) => [
    check('quest_condition_item_position_check', sql`${table.position} >= 0`),
    check('quest_condition_item_text_check', sql`btrim(${table.text}) <> ''`),
    unique('quest_condition_item_quest_id_position_key').on(table.questId, table.position),
    index('quest_condition_item_quest_id_idx').on(table.questId),
  ],
);

export const review = pgTable(
  'review',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    questId: uuid('quest_id')
      .notNull()
      .references(() => quest.id),
    reviewerId: uuid('reviewer_id')
      .notNull()
      .references(() => authUser.id),
    revieweeId: uuid('reviewee_id')
      .notNull()
      .references(() => authUser.id),
    rating: smallint('rating').notNull(),
    comment: varchar('comment', { length: 1000 }),
    createdAt: time('created_at').defaultNow().notNull(),
    updatedAt: time('updated_at').defaultNow().notNull(),
  },
  (table) => [
    check('review_rating_check', sql`${table.rating} BETWEEN 1 AND 5`),
    check('review_participants_check', sql`${table.reviewerId} <> ${table.revieweeId}`),
    check('review_comment_check', sql`${table.comment} IS NULL OR btrim(${table.comment}) <> ''`),
    unique('review_quest_reviewer_reviewee_key').on(
      table.questId,
      table.reviewerId,
      table.revieweeId,
    ),
    index('review_quest_id_idx').on(table.questId),
    index('review_reviewee_id_idx').on(table.revieweeId),
  ],
);

export const questLocation = pgTable(
  'quest_location',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    questId: uuid('quest_id')
      .notNull()
      .references(() => quest.id, { onDelete: 'cascade' }),
    label: varchar('label', { length: 100 }),
  },
  (table) => [index('quest_location_quest_id_idx').on(table.questId)],
);

export const questImage = pgTable(
  'quest_image',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    questId: uuid('quest_id')
      .notNull()
      .references(() => quest.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => file.id),
    position: integer('position').default(0).notNull(),
  },
  (table) => [
    unique('quest_image_quest_id_position_key').on(table.questId, table.position),
    index('quest_image_quest_id_idx').on(table.questId),
  ],
);

export const questEditRequest = pgTable(
  'quest_edit_request',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    questId: uuid('quest_id')
      .notNull()
      .references(() => quest.id, { onDelete: 'cascade' }),
    requestedByUserId: uuid('requested_by_user_id')
      .notNull()
      .references(() => authUser.id),
    proposedChanges: jsonb('proposed_changes').notNull(),
    previousQuestStatus: questStatus('previous_quest_status').notNull(),
    requestStatus: varchar('request_status', { length: 32 })
      .default('EDIT_REQUEST_PENDING')
      .notNull(),
    createdAt: time('created_at').defaultNow().notNull(),
    resolvedAt: time('resolved_at'),
  },
  (table) => [
    check(
      'quest_edit_request_status_check',
      sql`${table.requestStatus} IN ('EDIT_REQUEST_PENDING', 'EDIT_REQUEST_APPROVED', 'EDIT_REQUEST_REJECTED')`,
    ),
    index('quest_edit_request_quest_idx').on(table.questId),
    uniqueIndex('quest_edit_request_one_pending_uidx')
      .on(table.questId)
      .where(sql`${table.requestStatus} = 'EDIT_REQUEST_PENDING'`),
  ],
);

export const questEditRequestResponse = pgTable(
  'quest_edit_request_response',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => questEditRequest.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id),
    decision: varchar('decision', { length: 32 }),
    respondedAt: time('responded_at'),
  },
  (table) => [
    check(
      'quest_edit_request_response_decision_check',
      sql`${table.decision} IN ('EDIT_RESPONSE_APPROVED', 'EDIT_RESPONSE_REJECTED')`,
    ),
    unique('quest_edit_request_response_request_id_user_id_key').on(
      table.requestId,
      table.userId,
    ),
    index('quest_edit_request_response_request_idx').on(table.requestId),
  ],
);

export const questV2EditRequest = pgTable(
  'quest_v2_edit_request',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    questId: uuid('quest_id')
      .notNull()
      .references(() => quest.id, { onDelete: 'cascade' }),
    previousCondition: jsonb('previous_condition').notNull(),
    proposedCondition: jsonb('proposed_condition').notNull(),
    requestStatus: varchar('request_status', { length: 32 })
      .$type<'EDIT_REQUEST_PENDING' | 'EDIT_REQUEST_APPLIED' | 'EDIT_REQUEST_FAILED'>()
      .default('EDIT_REQUEST_PENDING')
      .notNull(),
    failureCode: varchar('failure_code', { length: 32 }).$type<
      'EDIT_REQUEST_DECLINED' | 'EDIT_REQUEST_TIMEOUT' | 'ACTIVE_WORKER_LEFT'
    >(),
    createdAt: time('created_at').defaultNow().notNull(),
    expiresAt: time('expires_at').notNull(),
    appliedAt: time('applied_at'),
    failedAt: time('failed_at'),
  },
  (table) => [
    check(
      'quest_v2_edit_request_status_check',
      sql`${table.requestStatus} IN ('EDIT_REQUEST_PENDING', 'EDIT_REQUEST_APPLIED', 'EDIT_REQUEST_FAILED')`,
    ),
    check(
      'quest_v2_edit_request_failure_code_check',
      sql`${table.failureCode} IS NULL OR ${table.failureCode} IN ('EDIT_REQUEST_DECLINED', 'EDIT_REQUEST_TIMEOUT', 'ACTIVE_WORKER_LEFT')`,
    ),
    check('quest_v2_edit_request_expiry_check', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'quest_v2_edit_request_applied_at_check',
      sql`(${table.appliedAt} IS NOT NULL) = (${table.requestStatus} = 'EDIT_REQUEST_APPLIED')`,
    ),
    check(
      'quest_v2_edit_request_failed_at_check',
      sql`(${table.failedAt} IS NOT NULL) = (${table.requestStatus} = 'EDIT_REQUEST_FAILED')`,
    ),
    check(
      'quest_v2_edit_request_failure_status_check',
      sql`(${table.failureCode} IS NOT NULL) = (${table.requestStatus} = 'EDIT_REQUEST_FAILED')`,
    ),
    index('quest_v2_edit_request_quest_idx').on(table.questId),
    uniqueIndex('quest_v2_edit_request_one_pending_uidx')
      .on(table.questId)
      .where(sql`${table.requestStatus} = 'EDIT_REQUEST_PENDING'`),
  ],
);

export const questV2EditRequestResponse = pgTable(
  'quest_v2_edit_request_response',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => questV2EditRequest.id, { onDelete: 'cascade' }),
    workerId: uuid('worker_id')
      .notNull()
      .references(() => authUser.id),
    decision: varchar('decision', { length: 32 }).$type<
      'EDIT_RESPONSE_ACCEPTED' | 'EDIT_RESPONSE_DECLINED'
    >(),
    reason: varchar('reason', { length: 255 }),
    respondedAt: time('responded_at'),
  },
  (table) => [
    check(
      'quest_v2_edit_request_response_decision_check',
      sql`${table.decision} IS NULL OR ${table.decision} IN ('EDIT_RESPONSE_ACCEPTED', 'EDIT_RESPONSE_DECLINED')`,
    ),
    check(
      'quest_v2_edit_request_response_reason_check',
      sql`${table.reason} IS NULL OR (${table.decision} = 'EDIT_RESPONSE_DECLINED' AND btrim(${table.reason}) <> '')`,
    ),
    check(
      'quest_v2_edit_request_response_responded_at_check',
      sql`(${table.respondedAt} IS NOT NULL) = (${table.decision} IS NOT NULL)`,
    ),
    unique('quest_v2_edit_request_response_request_worker_key').on(
      table.requestId,
      table.workerId,
    ),
    index('quest_v2_edit_request_response_request_idx').on(table.requestId),
    index('quest_v2_edit_request_response_worker_idx').on(table.workerId),
  ],
);

export const questEditHistory = pgTable(
  'quest_edit_history',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    questId: uuid('quest_id')
      .notNull()
      .references(() => quest.id, { onDelete: 'cascade' }),
    editRequestId: uuid('edit_request_id').references(() => questEditRequest.id),
    fieldName: varchar('field_name', { length: 100 }).notNull(),
    oldValue: jsonb('old_value'),
    newValue: jsonb('new_value'),
    editedAt: time('edited_at').defaultNow().notNull(),
    editedByUserId: uuid('edited_by_user_id').references(() => authUser.id),
    editedByAdminId: uuid('edited_by_admin_id').references(() => authAdmin.id),
  },
  (table) => [
    check(
      'quest_edit_history_editor_check',
      sql`num_nonnulls(${table.editedByUserId}, ${table.editedByAdminId}) <= 1`,
    ),
    index('quest_edit_history_quest_idx').on(table.questId, table.editedAt),
  ],
);

export const questTeam = pgTable(
  'quest_team',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    questId: uuid('quest_id')
      .notNull()
      .references(() => quest.id, { onDelete: 'cascade' }),
    leaderId: uuid('leader_id')
      .notNull()
      .references(() => authUser.id),
    name: varchar('name', { length: 100 }).notNull(),
    teamStatus: varchar('team_status', { length: 32 })
      .default('TEAM_FORMING')
      .notNull(),
    reworkLimit: integer('rework_limit').default(0).notNull(),
    createdAt: time('created_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'quest_team_status_check',
      sql`${table.teamStatus} IN ('TEAM_FORMING', 'TEAM_SUBMITTED', 'TEAM_SELECTED', 'TEAM_REJECTED', 'TEAM_DISBANDED')`,
    ),
    check('quest_team_rework_limit_check', sql`${table.reworkLimit} >= 0`),
    unique('quest_team_id_leader_id_key').on(table.id, table.leaderId),
    index('quest_team_quest_id_idx').on(table.questId),
    uniqueIndex('quest_team_one_selected_uidx')
      .on(table.questId)
      .where(sql`${table.teamStatus} = 'TEAM_SELECTED'`),
  ],
);

export const questTeamMember = pgTable(
  'quest_team_member',
  {
    teamId: uuid('team_id')
      .notNull()
      .references(() => questTeam.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id),
    joinedAt: time('joined_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.teamId, table.userId] }),
    index('quest_team_member_user_id_idx').on(table.userId),
  ],
);

export const questCandidateApplicationV2 = pgTable(
  'quest_candidate_application_v2',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    questId: uuid('quest_id')
      .notNull()
      .references(() => quest.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => authUser.id),
    state: varchar('state', { length: 32 })
      .default('APPLICATION_APPLIED')
      .notNull(),
    appliedAt: time('applied_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'quest_candidate_application_v2_state_check',
      sql`${table.state} IN ('APPLICATION_APPLIED', 'APPLICATION_SELECTED', 'APPLICATION_REJECTED', 'APPLICATION_WITHDRAWN')`,
    ),
    unique('quest_candidate_application_v2_quest_id_member_id_key').on(table.questId, table.memberId),
    index('quest_candidate_application_v2_quest_id_idx').on(table.questId),
    index('quest_candidate_application_v2_state_idx').on(table.state),
    uniqueIndex('quest_candidate_application_v2_one_selected_uidx')
      .on(table.questId)
      .where(sql`${table.state} = 'APPLICATION_SELECTED'`),
  ],
);

export const questCandidateTeamV2 = pgTable(
  'quest_candidate_team_v2',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    questId: uuid('quest_id')
      .notNull()
      .references(() => quest.id, { onDelete: 'cascade' }),
    leaderId: uuid('leader_id')
      .notNull()
      .references(() => authUser.id),
    name: varchar('name', { length: 100 }).notNull(),
    headcount: integer('headcount').notNull(),
    state: varchar('state', { length: 32 })
      .default('TEAM_FORMING')
      .notNull(),
    joinCodeHash: varchar('join_code_hash', { length: 64 }),
    joinCodeExpiresAt: time('join_code_expires_at'),
    submissionText: varchar('submission_text', { length: 1000 }),
    submittedAt: time('submitted_at'),
    createdAt: time('created_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'quest_candidate_team_v2_state_check',
      sql`${table.state} IN ('TEAM_FORMING', 'TEAM_SUBMITTED', 'TEAM_SELECTED', 'TEAM_REJECTED', 'TEAM_DISBANDED')`,
    ),
    check('quest_candidate_team_v2_headcount_check', sql`${table.headcount} BETWEEN 2 AND 20`),
    check(
      'quest_candidate_team_v2_join_code_fields_check',
      sql`(${table.joinCodeHash} IS NULL) = (${table.joinCodeExpiresAt} IS NULL)`,
    ),
    check(
      'quest_candidate_team_v2_submission_fields_check',
      sql`(${table.submissionText} IS NULL) = (${table.submittedAt} IS NULL)`,
    ),
    check(
      'quest_candidate_team_v2_submission_text_check',
      sql`${table.submissionText} IS NULL OR btrim(${table.submissionText}) <> ''`,
    ),
    index('quest_candidate_team_v2_quest_id_idx').on(table.questId),
    uniqueIndex('quest_candidate_team_v2_one_selected_uidx')
      .on(table.questId)
      .where(sql`${table.state} = 'TEAM_SELECTED'`),
  ],
);

export const questCandidateTeamV2Member = pgTable(
  'quest_candidate_team_v2_member',
  {
    teamId: uuid('team_id')
      .notNull()
      .references(() => questCandidateTeamV2.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => authUser.id),
    joinedAt: time('joined_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.teamId, table.memberId] }),
    index('quest_candidate_team_v2_member_member_id_idx').on(table.memberId),
  ],
);

export const questCandidateTeamV2SubmissionFile = pgTable(
  'quest_candidate_team_v2_submission_file',
  {
    teamId: uuid('team_id')
      .notNull()
      .references(() => questCandidateTeamV2.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => file.id),
    position: integer('position').default(0).notNull(),
    attachedAt: time('attached_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.teamId, table.fileId] }),
    unique('quest_candidate_team_v2_submission_file_team_position_key').on(table.teamId, table.position),
    check('quest_candidate_team_v2_submission_file_position_check', sql`${table.position} >= 0`),
    index('quest_candidate_team_v2_submission_file_team_idx').on(table.teamId),
  ],
);

export const questV2ProofSubmission = pgTable(
  'quest_v2_proof_submission',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    questId: uuid('quest_id')
      .notNull()
      .references(() => quest.id, { onDelete: 'cascade' }),
    workerId: uuid('worker_id').references(() => authUser.id),
    teamId: uuid('team_id').references(() => questCandidateTeamV2.id),
    submittedByUserId: uuid('submitted_by_user_id')
      .notNull()
      .references(() => authUser.id),
    description: varchar('description', { length: 1000 }),
    submissionStatus: varchar('submission_status', { length: 32 }).$type<
      'PROOF_PENDING' | 'PROOF_APPROVED' | 'PROOF_NOT_APPROVED'
    >(),
    sentAt: time('sent_at'),
    createdAt: time('created_at').defaultNow().notNull(),
    updatedAt: time('updated_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'quest_v2_proof_submission_owner_check',
      sql`num_nonnulls(${table.workerId}, ${table.teamId}) = 1`,
    ),
    check(
      'quest_v2_proof_submission_status_check',
      sql`${table.submissionStatus} IS NULL OR ${table.submissionStatus} IN ('PROOF_PENDING', 'PROOF_APPROVED', 'PROOF_NOT_APPROVED')`,
    ),
    check(
      'quest_v2_proof_submission_draft_check',
      sql`(${table.submissionStatus} IS NULL) = (${table.sentAt} IS NULL)`,
    ),
    check(
      'quest_v2_proof_submission_description_check',
      sql`${table.description} IS NULL OR btrim(${table.description}) <> ''`,
    ),
    uniqueIndex('quest_v2_proof_submission_one_worker_uidx').on(table.questId, table.workerId),
    uniqueIndex('quest_v2_proof_submission_one_team_uidx').on(table.questId, table.teamId),
    index('quest_v2_proof_submission_quest_idx').on(table.questId),
    index('quest_v2_proof_submission_worker_idx').on(table.workerId),
    index('quest_v2_proof_submission_team_idx').on(table.teamId),
    index('quest_v2_proof_submission_status_idx').on(table.submissionStatus),
  ],
);

export const questV2ProofSubmissionFile = pgTable(
  'quest_v2_proof_submission_file',
  {
    proofSubmissionId: uuid('proof_submission_id')
      .notNull()
      .references(() => questV2ProofSubmission.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => file.id),
    position: integer('position').default(0).notNull(),
    attachedAt: time('attached_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.proofSubmissionId, table.fileId] }),
    unique('quest_v2_proof_submission_file_position_key').on(
      table.proofSubmissionId,
      table.position,
    ),
    check('quest_v2_proof_submission_file_position_check', sql`${table.position} >= 0 AND ${table.position} < 5`),
    index('quest_v2_proof_submission_file_submission_idx').on(table.proofSubmissionId),
  ],
);

export const questV2CompletionConfirmation = pgTable(
  'quest_v2_completion_confirmation',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    questId: uuid('quest_id')
      .notNull()
      .references(() => quest.id, { onDelete: 'cascade' }),
    workerId: uuid('worker_id').references(() => authUser.id),
    teamId: uuid('team_id').references(() => questCandidateTeamV2.id),
    confirmedByUserId: uuid('confirmed_by_user_id')
      .notNull()
      .references(() => authUser.id),
    confirmedAt: time('confirmed_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'quest_v2_completion_confirmation_owner_check',
      sql`num_nonnulls(${table.workerId}, ${table.teamId}) = 1`,
    ),
    unique('quest_v2_completion_confirmation_worker_key').on(table.questId, table.workerId),
    unique('quest_v2_completion_confirmation_team_key').on(table.questId, table.teamId),
    index('quest_v2_completion_confirmation_quest_idx').on(table.questId),
  ],
);

export const questTeamInvitation = pgTable(
  'quest_team_invitation',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => questTeam.id, { onDelete: 'cascade' }),
    invitedUserId: uuid('invited_user_id')
      .notNull()
      .references(() => authUser.id),
    invitedByUserId: uuid('invited_by_user_id')
      .notNull()
      .references(() => authUser.id),
    invitationStatus: varchar('invitation_status', { length: 32 })
      .default('INVITATION_PENDING')
      .notNull(),
    createdAt: time('created_at').defaultNow().notNull(),
    respondedAt: time('responded_at'),
    expiresAt: time('expires_at').notNull(),
  },
  (table) => [
    check(
      'quest_team_invitation_status_check',
      sql`${table.invitationStatus} IN ('INVITATION_PENDING', 'INVITATION_ACCEPTED', 'INVITATION_DECLINED', 'INVITATION_EXPIRED', 'INVITATION_REVOKED')`,
    ),
    check('quest_team_invitation_expires_at_check', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'quest_team_invitation_responded_at_check',
      sql`(${table.respondedAt} IS NULL) = (${table.invitationStatus} = 'INVITATION_PENDING')`,
    ),
    index('quest_team_invitation_team_id_idx').on(table.teamId),
    index('quest_team_invitation_invited_user_id_idx').on(table.invitedUserId),
    uniqueIndex('quest_team_invitation_one_pending_uidx')
      .on(table.teamId, table.invitedUserId)
      .where(sql`${table.invitationStatus} = 'INVITATION_PENDING'`),
  ],
);

export const questApplication = pgTable(
  'quest_application',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    questId: uuid('quest_id')
      .notNull()
      .references(() => quest.id, { onDelete: 'cascade' }),
    workerId: uuid('worker_id')
      .notNull()
      .references(() => authUser.id),
    applicationStatus: varchar('application_status', { length: 32 })
      .default('APPLICATION_APPLIED')
      .notNull(),
    reworkLimit: integer('rework_limit').default(0).notNull(),
    appliedAt: time('applied_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'quest_application_status_check',
      sql`${table.applicationStatus} IN ('APPLICATION_APPLIED', 'APPLICATION_SELECTED', 'APPLICATION_REJECTED', 'APPLICATION_WITHDRAWN')`,
    ),
    check('quest_application_rework_limit_check', sql`${table.reworkLimit} >= 0`),
    unique('quest_application_quest_id_worker_id_key').on(table.questId, table.workerId),
    index('quest_application_quest_id_idx').on(table.questId),
    index('quest_application_status_idx').on(table.applicationStatus),
    uniqueIndex('quest_application_one_selected_uidx')
      .on(table.questId)
      .where(sql`${table.applicationStatus} = 'APPLICATION_SELECTED'`),
  ],
);

export const questAssignment = pgTable(
  'quest_assignment',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    questId: uuid('quest_id')
      .notNull()
      .references(() => quest.id, { onDelete: 'cascade' }),
    workerId: uuid('worker_id')
      .notNull()
      .references(() => authUser.id),
    assignmentStatus: varchar('assignment_status', { length: 32 })
      .default('ASSIGNMENT_ACTIVE')
      .notNull(),
    startedAt: time('started_at'),
    createdAt: time('created_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'quest_assignment_status_check',
      sql`${table.assignmentStatus} IN ('ASSIGNMENT_ACTIVE', 'ASSIGNMENT_COMPLETED', 'ASSIGNMENT_INCOMPLETE', 'ASSIGNMENT_CANCELLED')`,
    ),
    unique('quest_assignment_quest_id_worker_id_key').on(table.questId, table.workerId),
    index('quest_assignment_quest_id_idx').on(table.questId),
    index('quest_assignment_worker_id_idx').on(table.workerId),
    index('quest_assignment_status_idx').on(table.assignmentStatus),
  ],
);

export const questV2UnderfilledDecision = pgTable(
  'quest_v2_underfilled_decisions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    questId: uuid('quest_id')
      .notNull()
      .references(() => quest.id, { onDelete: 'cascade' }),
    activeWorkerCount: integer('active_worker_count').notNull(),
    workerRewardPoolSatang: integer('worker_reward_pool_satang').notNull(),
    state: varchar('state', { length: 40 })
      .$type<
        'UNDERFILLED_DECISION_PENDING' |
          'UNDERFILLED_CONSENT_PENDING' |
          'UNDERFILLED_COMPLETED' |
          'UNDERFILLED_CANCELLED'
      >()
      .default('UNDERFILLED_DECISION_PENDING')
      .notNull(),
    decision: varchar('decision', { length: 16 }).$type<'PROCEED' | 'CANCEL'>(),
    decisionExpiresAt: time('decision_expires_at').notNull(),
    consentExpiresAt: time('consent_expires_at'),
    detectedAt: time('detected_at').notNull(),
    resolvedAt: time('resolved_at'),
    resolutionCode: varchar('resolution_code', { length: 32 }).$type<
      'HIRER_CANCELLED' | 'HIRER_DECISION_TIMEOUT' | 'WORKER_DECLINED' | 'WORKER_CONSENT_TIMEOUT'
    >(),
  },
  (table) => [
    unique('quest_v2_underfilled_decisions_quest_id_key').on(table.questId),
    check(
      'quest_v2_underfilled_decisions_state_check',
      sql`${table.state} IN ('UNDERFILLED_DECISION_PENDING', 'UNDERFILLED_CONSENT_PENDING', 'UNDERFILLED_COMPLETED', 'UNDERFILLED_CANCELLED')`,
    ),
    check('quest_v2_underfilled_decisions_worker_count_check', sql`${table.activeWorkerCount} > 0`),
    check('quest_v2_underfilled_decisions_pool_check', sql`${table.workerRewardPoolSatang} > 0`),
    check(
      'quest_v2_underfilled_decisions_decision_check',
      sql`${table.decision} IS NULL OR ${table.decision} IN ('PROCEED', 'CANCEL')`,
    ),
    check(
      'quest_v2_underfilled_decisions_resolution_check',
      sql`${table.resolutionCode} IS NULL OR ${table.resolutionCode} IN ('HIRER_CANCELLED', 'HIRER_DECISION_TIMEOUT', 'WORKER_DECLINED', 'WORKER_CONSENT_TIMEOUT')`,
    ),
    index('quest_v2_underfilled_decisions_state_idx').on(table.state),
    index('quest_v2_underfilled_decisions_decision_expires_at_idx').on(table.decisionExpiresAt),
    index('quest_v2_underfilled_decisions_consent_expires_at_idx').on(table.consentExpiresAt),
  ],
);

export const questV2UnderfilledConsent = pgTable(
  'quest_v2_underfilled_consents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    decisionId: uuid('decision_id')
      .notNull()
      .references(() => questV2UnderfilledDecision.id, { onDelete: 'cascade' }),
    questId: uuid('quest_id')
      .notNull()
      .references(() => quest.id, { onDelete: 'cascade' }),
    assignmentId: uuid('assignment_id')
      .notNull()
      .references(() => questAssignment.id, { onDelete: 'cascade' }),
    workerId: uuid('worker_id')
      .notNull()
      .references(() => authUser.id),
    rewardSatang: integer('reward_satang').notNull(),
    decision: varchar('decision', { length: 16 }).$type<'ACCEPT' | 'DECLINE'>(),
    respondedAt: time('responded_at'),
    createdAt: time('created_at').defaultNow().notNull(),
  },
  (table) => [
    unique('quest_v2_underfilled_consents_decision_worker_key').on(table.decisionId, table.workerId),
    unique('quest_v2_underfilled_consents_decision_assignment_key').on(table.decisionId, table.assignmentId),
    check('quest_v2_underfilled_consents_reward_check', sql`${table.rewardSatang} > 0`),
    check(
      'quest_v2_underfilled_consents_decision_check',
      sql`${table.decision} IS NULL OR ${table.decision} IN ('ACCEPT', 'DECLINE')`,
    ),
    check(
      'quest_v2_underfilled_consents_response_check',
      sql`(${table.decision} IS NULL) = (${table.respondedAt} IS NULL)`,
    ),
    index('quest_v2_underfilled_consents_quest_id_idx').on(table.questId),
    index('quest_v2_underfilled_consents_worker_id_idx').on(table.workerId),
  ],
);

/** Durable command identity and replay result for Quest terminal settlement commands. */
export const questSettlementCommand = pgTable(
  'quest_settlement_commands',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    commandId: varchar('command_id', { length: 200 }).notNull(),
    questId: uuid('quest_id').notNull().references(() => quest.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => authUser.id),
    actorAdminId: uuid('actor_admin_id').references(() => authAdmin.id),
    commandType: varchar('command_type', { length: 32 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    resultData: jsonb('result_data'),
    processingStatus: varchar('processing_status', { length: 32 }).default('PROCESSING').notNull(),
    createdAt: time('created_at').defaultNow().notNull(),
    completedAt: time('completed_at'),
  },
  (table) => [
    unique('quest_settlement_commands_command_id_key').on(table.commandId),
    check(
      'quest_settlement_commands_actor_check',
      sql`(${table.commandType} = 'AUTO_CANCEL' AND num_nonnulls(${table.actorUserId}, ${table.actorAdminId}) = 0) OR (${table.commandType} <> 'AUTO_CANCEL' AND num_nonnulls(${table.actorUserId}, ${table.actorAdminId}) = 1)`,
    ),
    check('quest_settlement_commands_type_check', sql`${table.commandType} IN ('COMPLETE', 'CANCEL', 'DISPUTE_REFUND', 'DISPUTE_RELEASE', 'AUTO_CANCEL')`),
    check('quest_settlement_commands_status_check', sql`${table.processingStatus} IN ('PROCESSING', 'COMPLETED')`),
    check('quest_settlement_commands_completion_check', sql`(${table.processingStatus} = 'COMPLETED') = (${table.completedAt} IS NOT NULL)`),
    check('quest_settlement_commands_result_check', sql`${table.processingStatus} = 'PROCESSING' OR ${table.resultData} IS NOT NULL`),
    index('quest_settlement_commands_quest_id_idx').on(table.questId),
  ],
);

/** Durable command identity and replay result for direct Worker joins. */
export const questDirectJoinCommand = pgTable(
  'quest_direct_join_commands',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    commandId: varchar('command_id', { length: 200 }).notNull(),
    workerId: uuid('worker_id')
      .notNull()
      .references(() => authUser.id),
    questId: uuid('quest_id')
      .notNull()
      .references(() => quest.id, { onDelete: 'cascade' }),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    assignmentId: uuid('assignment_id').references(() => questAssignment.id, { onDelete: 'cascade' }),
    resultAssignmentStatus: varchar('result_assignment_status', { length: 32 }),
    resultStartedAt: time('result_started_at'),
    resultCreatedAt: time('result_created_at'),
    resultQuestStatus: questStatus('result_quest_status'),
    processingStatus: varchar('processing_status', { length: 32 })
      .default('PROCESSING')
      .notNull(),
    createdAt: time('created_at').defaultNow().notNull(),
    completedAt: time('completed_at'),
  },
  (table) => [
    unique('quest_direct_join_commands_command_id_key').on(table.commandId),
    unique('quest_direct_join_commands_assignment_id_key').on(table.assignmentId),
    check(
      'quest_direct_join_commands_status_check',
      sql`${table.processingStatus} IN ('PROCESSING', 'COMPLETED')`,
    ),
    check(
      'quest_direct_join_commands_completion_check',
      sql`(${table.processingStatus} = 'COMPLETED') = (${table.completedAt} IS NOT NULL)`,
    ),
    check(
      'quest_direct_join_commands_result_check',
      sql`${table.processingStatus} = 'PROCESSING' OR (${table.assignmentId} IS NOT NULL AND ${table.resultAssignmentStatus} IS NOT NULL AND ${table.resultCreatedAt} IS NOT NULL AND ${table.resultQuestStatus} IS NOT NULL)`,
    ),
    index('quest_direct_join_commands_quest_id_idx').on(table.questId),
    index('quest_direct_join_commands_worker_id_idx').on(table.workerId),
  ],
);

export const proofSubmission = pgTable(
  'proof_submission',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    questId: uuid('quest_id')
      .notNull()
      .references(() => quest.id, { onDelete: 'cascade' }),
    workerId: uuid('worker_id').references(() => authUser.id),
    teamId: uuid('team_id').references(() => questTeam.id),
    submittedByUserId: uuid('submitted_by_user_id')
      .notNull()
      .references(() => authUser.id),
    content: varchar('content', { length: 5000 }).notNull(),
    submissionStatus: varchar('submission_status', { length: 32 })
      .default('PROOF_PENDING')
      .notNull(),
    reviewNote: varchar('review_note', { length: 1000 }),
    submittedAt: time('submitted_at').defaultNow().notNull(),
    reviewedAt: time('reviewed_at'),
  },
  (table) => [
    check(
      'proof_submission_owner_check',
      sql`num_nonnulls(${table.workerId}, ${table.teamId}) = 1`,
    ),
    check(
      'proof_submission_status_check',
      sql`${table.submissionStatus} IN ('PROOF_PENDING', 'PROOF_APPROVED', 'PROOF_REJECTED', 'PROOF_AUTO_APPROVED')`,
    ),
    index('proof_submission_quest_id_idx').on(table.questId),
    index('proof_submission_status_idx').on(table.submissionStatus),
    index('proof_submission_worker_id_idx').on(table.workerId),
    index('proof_submission_team_id_idx').on(table.teamId),
  ],
);

export const questCompletionConfirmation = pgTable(
  'quest_completion_confirmation',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    questId: uuid('quest_id')
      .notNull()
      .references(() => quest.id, { onDelete: 'cascade' }),
    workerId: uuid('worker_id').references(() => authUser.id),
    teamId: uuid('team_id').references(() => questTeam.id),
    confirmedByUserId: uuid('confirmed_by_user_id')
      .notNull()
      .references(() => authUser.id),
    confirmedAt: time('confirmed_at').defaultNow().notNull(),
  },
  (table) => [
    check('quest_completion_confirmation_owner_check', sql`num_nonnulls(${table.workerId}, ${table.teamId}) = 1`),
    unique('quest_completion_confirmation_worker_key').on(table.questId, table.workerId),
    unique('quest_completion_confirmation_team_key').on(table.questId, table.teamId),
    index('quest_completion_confirmation_quest_idx').on(table.questId),
  ],
);

export const proofSubmissionImage = pgTable(
  'proof_submission_image',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    proofSubmissionId: uuid('proof_submission_id')
      .notNull()
      .references(() => proofSubmission.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => file.id),
    position: integer('position').default(0).notNull(),
  },
  (table) => [
    unique('proof_submission_image_submission_id_position_key').on(
      table.proofSubmissionId,
      table.position,
    ),
    index('proof_submission_image_submission_idx').on(table.proofSubmissionId),
  ],
);

export const questRelations = relations(quest, ({ one, many }) => ({
  hirer: one(authUser, {
    fields: [quest.hirerId],
    references: [authUser.id],
  }),
  tag: one(tag, {
    fields: [quest.tagId],
    references: [tag.id],
  }),
  cancelledByUser: one(authUser, {
    fields: [quest.cancelledByUserId],
    references: [authUser.id],
  }),
  cancelledByAdmin: one(authAdmin, {
    fields: [quest.cancelledByAdminId],
    references: [authAdmin.id],
  }),
  hiddenByAdmin: one(authAdmin, {
    fields: [quest.hiddenByAdminId],
    references: [authAdmin.id],
  }),
  locations: many(questLocation),
  conditionItems: many(questConditionItem),
  images: many(questImage),
  editRequests: many(questEditRequest),
  editHistory: many(questEditHistory),
  teams: many(questTeam),
  candidateApplicationsV2: many(questCandidateApplicationV2),
  candidateTeamsV2: many(questCandidateTeamV2),
  applications: many(questApplication),
  assignments: many(questAssignment),
  directJoinCommands: many(questDirectJoinCommand),
  settlementCommands: many(questSettlementCommand),
  candidateSelectionCommands: many(questCandidateSelectionCommand),
  proofSubmissions: many(proofSubmission),
  completionConfirmations: many(questCompletionConfirmation),
  proofSubmissionsV2: many(questV2ProofSubmission),
  completionConfirmationsV2: many(questV2CompletionConfirmation),
  reviews: many(review),
}));

export const reviewRelations = relations(review, ({ one }) => ({
  quest: one(quest, {
    fields: [review.questId],
    references: [quest.id],
  }),
  reviewer: one(authUser, {
    fields: [review.reviewerId],
    references: [authUser.id],
  }),
  reviewee: one(authUser, {
    fields: [review.revieweeId],
    references: [authUser.id],
  }),
}));

export const questLocationRelations = relations(questLocation, ({ one }) => ({
  quest: one(quest, {
    fields: [questLocation.questId],
    references: [quest.id],
  }),
}));

export const questConditionItemRelations = relations(questConditionItem, ({ one }) => ({
  quest: one(quest, {
    fields: [questConditionItem.questId],
    references: [quest.id],
  }),
}));

export const questImageRelations = relations(questImage, ({ one }) => ({
  quest: one(quest, {
    fields: [questImage.questId],
    references: [quest.id],
  }),
  file: one(file, {
    fields: [questImage.fileId],
    references: [file.id],
  }),
}));

export const questEditRequestRelations = relations(questEditRequest, ({ one, many }) => ({
  quest: one(quest, {
    fields: [questEditRequest.questId],
    references: [quest.id],
  }),
  requestedByUser: one(authUser, {
    fields: [questEditRequest.requestedByUserId],
    references: [authUser.id],
  }),
  responses: many(questEditRequestResponse),
}));

export const questEditRequestResponseRelations = relations(
  questEditRequestResponse,
  ({ one }) => ({
    request: one(questEditRequest, {
      fields: [questEditRequestResponse.requestId],
      references: [questEditRequest.id],
    }),
    user: one(authUser, {
      fields: [questEditRequestResponse.userId],
      references: [authUser.id],
    }),
  }),
);

export const questEditHistoryRelations = relations(questEditHistory, ({ one }) => ({
  quest: one(quest, {
    fields: [questEditHistory.questId],
    references: [quest.id],
  }),
  editRequest: one(questEditRequest, {
    fields: [questEditHistory.editRequestId],
    references: [questEditRequest.id],
  }),
  editedByUser: one(authUser, {
    fields: [questEditHistory.editedByUserId],
    references: [authUser.id],
  }),
  editedByAdmin: one(authAdmin, {
    fields: [questEditHistory.editedByAdminId],
    references: [authAdmin.id],
  }),
}));

export const questTeamRelations = relations(questTeam, ({ one, many }) => ({
  quest: one(quest, {
    fields: [questTeam.questId],
    references: [quest.id],
  }),
  leader: one(authUser, {
    fields: [questTeam.leaderId],
    references: [authUser.id],
  }),
  members: many(questTeamMember),
  invitations: many(questTeamInvitation),
  proofSubmissions: many(proofSubmission),
  completionConfirmations: many(questCompletionConfirmation),
}));

export const questTeamMemberRelations = relations(questTeamMember, ({ one }) => ({
  team: one(questTeam, {
    fields: [questTeamMember.teamId],
    references: [questTeam.id],
  }),
  user: one(authUser, {
    fields: [questTeamMember.userId],
    references: [authUser.id],
  }),
}));

export const questCandidateApplicationV2Relations = relations(questCandidateApplicationV2, ({ one }) => ({
  quest: one(quest, {
    fields: [questCandidateApplicationV2.questId],
    references: [quest.id],
  }),
  member: one(authUser, {
    fields: [questCandidateApplicationV2.memberId],
    references: [authUser.id],
  }),
}));

export const questCandidateTeamV2Relations = relations(questCandidateTeamV2, ({ one, many }) => ({
  quest: one(quest, {
    fields: [questCandidateTeamV2.questId],
    references: [quest.id],
  }),
  leader: one(authUser, {
    fields: [questCandidateTeamV2.leaderId],
    references: [authUser.id],
  }),
  members: many(questCandidateTeamV2Member),
  submissionFiles: many(questCandidateTeamV2SubmissionFile),
  proofSubmissions: many(questV2ProofSubmission),
  completionConfirmations: many(questV2CompletionConfirmation),
}));

export const questCandidateTeamV2MemberRelations = relations(questCandidateTeamV2Member, ({ one }) => ({
  team: one(questCandidateTeamV2, {
    fields: [questCandidateTeamV2Member.teamId],
    references: [questCandidateTeamV2.id],
  }),
  member: one(authUser, {
    fields: [questCandidateTeamV2Member.memberId],
    references: [authUser.id],
  }),
}));

export const questCandidateTeamV2SubmissionFileRelations = relations(questCandidateTeamV2SubmissionFile, ({ one }) => ({
  team: one(questCandidateTeamV2, {
    fields: [questCandidateTeamV2SubmissionFile.teamId],
    references: [questCandidateTeamV2.id],
  }),
  file: one(file, {
    fields: [questCandidateTeamV2SubmissionFile.fileId],
    references: [file.id],
  }),
}));

export const questV2ProofSubmissionRelations = relations(questV2ProofSubmission, ({ one, many }) => ({
  quest: one(quest, {
    fields: [questV2ProofSubmission.questId],
    references: [quest.id],
  }),
  worker: one(authUser, {
    fields: [questV2ProofSubmission.workerId],
    references: [authUser.id],
  }),
  team: one(questCandidateTeamV2, {
    fields: [questV2ProofSubmission.teamId],
    references: [questCandidateTeamV2.id],
  }),
  submittedByUser: one(authUser, {
    fields: [questV2ProofSubmission.submittedByUserId],
    references: [authUser.id],
  }),
  files: many(questV2ProofSubmissionFile),
}));

export const questV2ProofSubmissionFileRelations = relations(questV2ProofSubmissionFile, ({ one }) => ({
  proofSubmission: one(questV2ProofSubmission, {
    fields: [questV2ProofSubmissionFile.proofSubmissionId],
    references: [questV2ProofSubmission.id],
  }),
  file: one(file, {
    fields: [questV2ProofSubmissionFile.fileId],
    references: [file.id],
  }),
}));

export const questV2CompletionConfirmationRelations = relations(questV2CompletionConfirmation, ({ one }) => ({
  quest: one(quest, {
    fields: [questV2CompletionConfirmation.questId],
    references: [quest.id],
  }),
  worker: one(authUser, {
    fields: [questV2CompletionConfirmation.workerId],
    references: [authUser.id],
  }),
  team: one(questCandidateTeamV2, {
    fields: [questV2CompletionConfirmation.teamId],
    references: [questCandidateTeamV2.id],
  }),
  confirmedByUser: one(authUser, {
    fields: [questV2CompletionConfirmation.confirmedByUserId],
    references: [authUser.id],
  }),
}));

export const questTeamInvitationRelations = relations(questTeamInvitation, ({ one }) => ({
  team: one(questTeam, {
    fields: [questTeamInvitation.teamId],
    references: [questTeam.id],
  }),
  invitedUser: one(authUser, {
    fields: [questTeamInvitation.invitedUserId],
    references: [authUser.id],
  }),
  invitedByUser: one(authUser, {
    fields: [questTeamInvitation.invitedByUserId],
    references: [authUser.id],
  }),
}));

export const questApplicationRelations = relations(questApplication, ({ one }) => ({
  quest: one(quest, {
    fields: [questApplication.questId],
    references: [quest.id],
  }),
  worker: one(authUser, {
    fields: [questApplication.workerId],
    references: [authUser.id],
  }),
}));

export const questAssignmentRelations = relations(questAssignment, ({ one }) => ({
  quest: one(quest, {
    fields: [questAssignment.questId],
    references: [quest.id],
  }),
  worker: one(authUser, {
    fields: [questAssignment.workerId],
    references: [authUser.id],
  }),
  directJoinCommand: one(questDirectJoinCommand, {
    fields: [questAssignment.id],
    references: [questDirectJoinCommand.assignmentId],
  }),
}));

export const questSettlementCommandRelations = relations(questSettlementCommand, ({ one }) => ({
  quest: one(quest, {
    fields: [questSettlementCommand.questId],
    references: [quest.id],
  }),
  actorUser: one(authUser, {
    fields: [questSettlementCommand.actorUserId],
    references: [authUser.id],
  }),
  actorAdmin: one(authAdmin, {
    fields: [questSettlementCommand.actorAdminId],
    references: [authAdmin.id],
  }),
}));

export const questDirectJoinCommandRelations = relations(questDirectJoinCommand, ({ one }) => ({
  quest: one(quest, {
    fields: [questDirectJoinCommand.questId],
    references: [quest.id],
  }),
  worker: one(authUser, {
    fields: [questDirectJoinCommand.workerId],
    references: [authUser.id],
  }),
  assignment: one(questAssignment, {
    fields: [questDirectJoinCommand.assignmentId],
    references: [questAssignment.id],
  }),
}));

/** Durable command identity and replay result for Hirer Candidate selection. */
export const questCandidateSelectionCommand = pgTable(
  'quest_candidate_selection_commands',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    commandId: varchar('command_id', { length: 200 }).notNull(),
    hirerId: uuid('hirer_id').notNull().references(() => authUser.id),
    questId: uuid('quest_id').notNull().references(() => quest.id, { onDelete: 'cascade' }),
    targetType: varchar('target_type', { length: 32 }).notNull(),
    targetId: uuid('target_id').notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    resultAssignmentIds: jsonb('result_assignment_ids'),
    resultQuestStatus: questStatus('result_quest_status'),
    processingStatus: varchar('processing_status', { length: 32 }).default('PROCESSING').notNull(),
    createdAt: time('created_at').defaultNow().notNull(),
    completedAt: time('completed_at'),
  },
  (table) => [
    unique('quest_candidate_selection_commands_command_id_key').on(table.commandId),
    check('quest_candidate_selection_commands_target_type_check', sql`${table.targetType} IN ('APPLICATION', 'TEAM')`),
    check('quest_candidate_selection_commands_status_check', sql`${table.processingStatus} IN ('PROCESSING', 'COMPLETED')`),
    check('quest_candidate_selection_commands_completion_check', sql`(${table.processingStatus} = 'COMPLETED') = (${table.completedAt} IS NOT NULL)`),
    check('quest_candidate_selection_commands_result_check', sql`${table.processingStatus} = 'PROCESSING' OR (${table.resultAssignmentIds} IS NOT NULL AND ${table.resultQuestStatus} IS NOT NULL)`),
    index('quest_candidate_selection_commands_quest_id_idx').on(table.questId),
    index('quest_candidate_selection_commands_hirer_id_idx').on(table.hirerId),
  ],
);

export const questCompletionConfirmationRelations = relations(questCompletionConfirmation, ({ one }) => ({
  quest: one(quest, {
    fields: [questCompletionConfirmation.questId],
    references: [quest.id],
  }),
  worker: one(authUser, {
    fields: [questCompletionConfirmation.workerId],
    references: [authUser.id],
  }),
  team: one(questTeam, {
    fields: [questCompletionConfirmation.teamId],
    references: [questTeam.id],
  }),
  confirmedByUser: one(authUser, {
    fields: [questCompletionConfirmation.confirmedByUserId],
    references: [authUser.id],
  }),
}));

export const proofSubmissionRelations = relations(proofSubmission, ({ one, many }) => ({
  quest: one(quest, {
    fields: [proofSubmission.questId],
    references: [quest.id],
  }),
  worker: one(authUser, {
    fields: [proofSubmission.workerId],
    references: [authUser.id],
  }),
  team: one(questTeam, {
    fields: [proofSubmission.teamId],
    references: [questTeam.id],
  }),
  submittedByUser: one(authUser, {
    fields: [proofSubmission.submittedByUserId],
    references: [authUser.id],
  }),
  images: many(proofSubmissionImage),
}));

export const proofSubmissionImageRelations = relations(proofSubmissionImage, ({ one }) => ({
  proofSubmission: one(proofSubmission, {
    fields: [proofSubmissionImage.proofSubmissionId],
    references: [proofSubmission.id],
  }),
  file: one(file, {
    fields: [proofSubmissionImage.fileId],
    references: [file.id],
  }),
}));
