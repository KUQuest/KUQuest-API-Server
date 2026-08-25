import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { authAdmin, authUser } from './auth.schema';
import { file } from './file.schema';
import { tag } from './tag.schema';

const time = (name: string) => timestamp(name, { withTimezone: true });

export const questMode = pgEnum('quest_mode', ['FIRST_COME_FIRST_SERVED', 'CANDIDATE']);
export const questParticipation = pgEnum('quest_participation', ['SINGLE', 'GROUP']);
export const questStatus = pgEnum('quest_status', [
  'DRAFT',
  'OPEN',
  'AWAITING_CONSENT',
  'ASSIGNED',
  'IN_PROGRESS',
  'SUBMITTED',
  'APPROVED',
  'REWORK',
  'COMPLETED',
  'CANCELLED',
  'DISPUTED',
  'HIDDEN',
  'UNFILLED',
]);

export const quest = pgTable(
  'quest',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    giverId: text('giver_id').notNull().references(() => authUser.id),
    title: varchar('title', { length: 200 }).notNull(),
    description: varchar('description', { length: 2000 }),
    condition: varchar('condition', { length: 4000 }).notNull(),
    mode: questMode('mode').notNull(),
    participation: questParticipation('participation').default('SINGLE').notNull(),
    questStatus: questStatus('quest_status').default('DRAFT').notNull(),
    rewardSatang: integer('reward_satang').notNull(),
    tagId: uuid('tag_id').references(() => tag.id),
    headcount: integer('headcount').default(1).notNull(),
    startTime: time('start_time').notNull(),
    dueAt: time('due_at'),
    proofRequired: boolean('proof_required').default(true).notNull(),
    cancelledAt: time('cancelled_at'),
    cancelledByUserId: text('cancelled_by_user_id').references(() => authUser.id),
    cancelledByAdminId: text('cancelled_by_admin_id').references(() => authAdmin.id),
    hiddenAt: time('hidden_at'),
    hiddenByAdminId: text('hidden_by_admin_id').references(() => authAdmin.id),
    createdAt: time('created_at').defaultNow().notNull(),
    updatedAt: time('updated_at').defaultNow().notNull(),
  },
  (table) => [
    check('quest_reward_check', sql`${table.rewardSatang} > 0`),
    check('quest_headcount_check', sql`${table.headcount} > 0`),
    check(
      'quest_participation_headcount_check',
      sql`${table.participation} = 'GROUP' OR ${table.headcount} = 1`,
    ),
    check('quest_due_at_check', sql`${table.dueAt} IS NULL OR ${table.dueAt} > ${table.startTime}`),
    check('quest_tag_check', sql`${table.questStatus} = 'DRAFT' OR ${table.tagId} IS NOT NULL`),
    check(
      'quest_cancelled_by_check',
      sql`num_nonnulls(${table.cancelledByUserId}, ${table.cancelledByAdminId}) <= 1`,
    ),
    check(
      'quest_cancelled_at_check',
      sql`(${table.cancelledAt} IS NULL) = (${table.questStatus} <> 'CANCELLED')`,
    ),
    check(
      'quest_hidden_at_check',
      sql`(${table.hiddenAt} IS NULL) = (${table.questStatus} <> 'HIDDEN')`,
    ),
    check(
      'quest_hidden_by_check',
      sql`(${table.hiddenByAdminId} IS NULL) = (${table.hiddenAt} IS NULL)`,
    ),
    index('quest_giver_id_idx').on(table.giverId),
    index('quest_status_idx').on(table.questStatus),
    index('quest_mode_idx').on(table.mode),
    index('quest_tag_id_idx').on(table.tagId),
    index('quest_start_time_idx').on(table.startTime),
  ],
);

export const review = pgTable(
  'review',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    questId: uuid('quest_id').notNull().references(() => quest.id),
    reviewerId: text('reviewer_id').notNull().references(() => authUser.id),
    revieweeId: text('reviewee_id').notNull().references(() => authUser.id),
    rating: smallint('rating').notNull(),
    comment: varchar('comment', { length: 1000 }).notNull(),
    createdAt: time('created_at').defaultNow().notNull(),
    updatedAt: time('updated_at').defaultNow().notNull(),
  },
  (table) => [
    check('review_rating_check', sql`${table.rating} BETWEEN 1 AND 5`),
    check('review_participants_check', sql`${table.reviewerId} <> ${table.revieweeId}`),
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
    questId: uuid('quest_id').notNull().references(() => quest.id, { onDelete: 'cascade' }),
    label: varchar('label', { length: 100 }),
    address: varchar('address', { length: 500 }),
    lat: numeric('lat', { precision: 9, scale: 6 }).notNull(),
    lng: numeric('lng', { precision: 9, scale: 6 }).notNull(),
    position: integer('position').default(1).notNull(),
  },
  (table) => [
    check('quest_location_lat_check', sql`${table.lat} BETWEEN -90 AND 90`),
    check('quest_location_lng_check', sql`${table.lng} BETWEEN -180 AND 180`),
    unique('quest_location_quest_id_position_key').on(table.questId, table.position),
    index('quest_location_quest_id_idx').on(table.questId),
  ],
);

export const questImage = pgTable(
  'quest_image',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    questId: uuid('quest_id').notNull().references(() => quest.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id').notNull().references(() => file.id),
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
    questId: uuid('quest_id').notNull().references(() => quest.id, { onDelete: 'cascade' }),
    requestedByUserId: text('requested_by_user_id').notNull().references(() => authUser.id),
    proposedChanges: jsonb('proposed_changes').notNull(),
    requestStatus: varchar('request_status', { length: 32 }).default('PENDING').notNull(),
    createdAt: time('created_at').defaultNow().notNull(),
    resolvedAt: time('resolved_at'),
  },
  (table) => [
    check(
      'quest_edit_request_status_check',
      sql`${table.requestStatus} IN ('PENDING', 'APPROVED', 'REJECTED')`,
    ),
    index('quest_edit_request_quest_idx').on(table.questId),
  ],
);

export const questEditRequestResponse = pgTable(
  'quest_edit_request_response',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => questEditRequest.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => authUser.id),
    decision: varchar('decision', { length: 32 }).notNull(),
    respondedAt: time('responded_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'quest_edit_request_response_decision_check',
      sql`${table.decision} IN ('APPROVED', 'REJECTED')`,
    ),
    unique('quest_edit_request_response_request_id_user_id_key').on(
      table.requestId,
      table.userId,
    ),
    index('quest_edit_request_response_request_idx').on(table.requestId),
  ],
);

export const questEditHistory = pgTable(
  'quest_edit_history',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    questId: uuid('quest_id').notNull().references(() => quest.id, { onDelete: 'cascade' }),
    editRequestId: uuid('edit_request_id').references(() => questEditRequest.id),
    fieldName: varchar('field_name', { length: 100 }).notNull(),
    oldValue: jsonb('old_value'),
    newValue: jsonb('new_value'),
    editedAt: time('edited_at').defaultNow().notNull(),
    editedByUserId: text('edited_by_user_id').references(() => authUser.id),
    editedByAdminId: text('edited_by_admin_id').references(() => authAdmin.id),
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
    questId: uuid('quest_id').notNull().references(() => quest.id, { onDelete: 'cascade' }),
    leaderId: text('leader_id').notNull().references(() => authUser.id),
    name: varchar('name', { length: 100 }).notNull(),
    teamStatus: varchar('team_status', { length: 32 }).default('FORMING').notNull(),
    reworkLimit: integer('rework_limit').default(0).notNull(),
    createdAt: time('created_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'quest_team_status_check',
      sql`${table.teamStatus} IN ('FORMING', 'SUBMITTED', 'SELECTED', 'REJECTED')`,
    ),
    check('quest_team_rework_limit_check', sql`${table.reworkLimit} >= 0`),
    index('quest_team_quest_id_idx').on(table.questId),
    uniqueIndex('quest_team_one_selected_uidx')
      .on(table.questId)
      .where(sql`${table.teamStatus} = 'SELECTED'`),
  ],
);

export const questTeamMember = pgTable(
  'quest_team_member',
  {
    teamId: uuid('team_id').notNull().references(() => questTeam.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => authUser.id),
    joinedAt: time('joined_at').defaultNow().notNull(),
  },
  (table) => [
    unique('quest_team_member_team_id_user_id_key').on(table.teamId, table.userId),
    index('quest_team_member_user_id_idx').on(table.userId),
  ],
);

export const questApplication = pgTable(
  'quest_application',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    questId: uuid('quest_id').notNull().references(() => quest.id, { onDelete: 'cascade' }),
    hunterId: text('hunter_id').notNull().references(() => authUser.id),
    applicationStatus: varchar('application_status', { length: 32 })
      .default('APPLIED')
      .notNull(),
    reworkLimit: integer('rework_limit').default(0).notNull(),
    appliedAt: time('applied_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'quest_application_status_check',
      sql`${table.applicationStatus} IN ('APPLIED', 'SELECTED', 'REJECTED')`,
    ),
    check('quest_application_rework_limit_check', sql`${table.reworkLimit} >= 0`),
    unique('quest_application_quest_id_hunter_id_key').on(table.questId, table.hunterId),
    index('quest_application_quest_id_idx').on(table.questId),
    index('quest_application_status_idx').on(table.applicationStatus),
    uniqueIndex('quest_application_one_selected_uidx')
      .on(table.questId)
      .where(sql`${table.applicationStatus} = 'SELECTED'`),
  ],
);

export const questAssignment = pgTable(
  'quest_assignment',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    questId: uuid('quest_id').notNull().references(() => quest.id, { onDelete: 'cascade' }),
    hunterId: text('hunter_id').notNull().references(() => authUser.id),
    assignmentStatus: varchar('assignment_status', { length: 32 })
      .default('ACTIVE')
      .notNull(),
    startedAt: time('started_at'),
    createdAt: time('created_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'quest_assignment_status_check',
      sql`${table.assignmentStatus} IN ('ACTIVE', 'COMPLETED', 'INCOMPLETE', 'CANCELLED')`,
    ),
    unique('quest_assignment_quest_id_hunter_id_key').on(table.questId, table.hunterId),
    index('quest_assignment_quest_id_idx').on(table.questId),
    index('quest_assignment_hunter_id_idx').on(table.hunterId),
    index('quest_assignment_status_idx').on(table.assignmentStatus),
  ],
);

export const proofSubmission = pgTable(
  'proof_submission',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    questId: uuid('quest_id').notNull().references(() => quest.id, { onDelete: 'cascade' }),
    hunterId: text('hunter_id').references(() => authUser.id),
    teamId: uuid('team_id').references(() => questTeam.id),
    submittedByUserId: text('submitted_by_user_id').notNull().references(() => authUser.id),
    content: varchar('content', { length: 5000 }).notNull(),
    submissionStatus: varchar('submission_status', { length: 32 })
      .default('PENDING')
      .notNull(),
    reviewNote: varchar('review_note', { length: 1000 }),
    submittedAt: time('submitted_at').defaultNow().notNull(),
    reviewedAt: time('reviewed_at'),
  },
  (table) => [
    check(
      'proof_submission_owner_check',
      sql`num_nonnulls(${table.hunterId}, ${table.teamId}) = 1`,
    ),
    check(
      'proof_submission_status_check',
      sql`${table.submissionStatus} IN ('PENDING', 'APPROVED', 'REJECTED', 'AUTO_APPROVED')`,
    ),
    index('proof_submission_quest_id_idx').on(table.questId),
    index('proof_submission_status_idx').on(table.submissionStatus),
    index('proof_submission_hunter_id_idx').on(table.hunterId),
    index('proof_submission_team_id_idx').on(table.teamId),
  ],
);

export const proofSubmissionImage = pgTable(
  'proof_submission_image',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    proofSubmissionId: uuid('proof_submission_id')
      .notNull()
      .references(() => proofSubmission.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id').notNull().references(() => file.id),
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
