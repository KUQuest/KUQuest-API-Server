import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
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

import { authUser } from './auth.schema';
import { file } from './file.schema';
import { quest, questAssignment } from './quest.schema';

const time = (name: string) => timestamp(name, { withTimezone: true });

export const chatMembershipRole = pgEnum('chat_membership_role', ['HIRER', 'WORKER']);
export const chatMessageKind = pgEnum('chat_message_kind', ['USER', 'SYSTEM']);
export const chatAttachmentStatus = pgEnum('chat_attachment_status', [
  'QUARANTINED',
  'VALIDATED',
  'REJECTED',
  'CONSUMED',
  'HIDDEN',
  'EXPIRED',
]);

export const chatConversation = pgTable(
  'chat_conversation',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    questId: uuid('quest_id')
      .notNull()
      .references(() => quest.id, { onDelete: 'restrict' }),
    questTitle: varchar('quest_title', { length: 200 }).notNull(),
    questStatus: varchar('quest_status', { length: 50 }).notNull(),
    nextSequence: bigint('next_sequence', { mode: 'number' }).default(1).notNull(),
    readOnlyAt: time('read_only_at'),
    archivedAt: time('archived_at'),
    latestTerminalAt: time('latest_terminal_at'),
    deletedAt: time('deleted_at'),
    createdAt: time('created_at').defaultNow().notNull(),
    updatedAt: time('updated_at').defaultNow().notNull(),
  },
  (table) => [
    unique('chat_conversation_quest_id_key').on(table.questId),
    check('chat_conversation_title_check', sql`btrim(${table.questTitle}) <> ''`),
    check('chat_conversation_status_snapshot_check', sql`btrim(${table.questStatus}) <> ''`),
    check('chat_conversation_next_sequence_check', sql`${table.nextSequence} > 0`),
    check(
      'chat_conversation_terminal_time_check',
      sql`${table.latestTerminalAt} IS NULL OR ${table.readOnlyAt} IS NOT NULL`,
    ),
    check(
      'chat_conversation_lifecycle_time_order_check',
      sql`(${table.latestTerminalAt} IS NULL OR ${table.readOnlyAt} IS NULL OR ${table.latestTerminalAt} <= ${table.readOnlyAt}) AND (${table.archivedAt} IS NULL OR ${table.readOnlyAt} IS NULL OR ${table.archivedAt} >= ${table.readOnlyAt})`,
    ),
  ],
);

export const chatMembership = pgTable(
  'chat_membership',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id').notNull(),
    assignmentId: uuid('assignment_id'),
    memberId: uuid('member_id').references(() => authUser.id, { onDelete: 'set null' }),
    role: chatMembershipRole('role').notNull(),
    joinedAt: time('joined_at').notNull(),
    leftAt: time('left_at'),
    createdAt: time('created_at').defaultNow().notNull(),
  },
  (table) => [
    unique('chat_membership_conversation_id_id_key').on(table.conversationId, table.id),
    uniqueIndex('chat_membership_assignment_uidx')
      .on(table.conversationId, table.assignmentId)
      .where(sql`${table.assignmentId} IS NOT NULL`),
    foreignKey({
      name: 'chat_membership_conversation_fk',
      columns: [table.conversationId],
      foreignColumns: [chatConversation.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'chat_membership_assignment_fk',
      columns: [table.assignmentId],
      foreignColumns: [questAssignment.id],
    }).onDelete('restrict'),
    check(
      'chat_membership_role_assignment_check',
      sql`(${table.role} = 'HIRER' AND ${table.assignmentId} IS NULL) OR (${table.role} = 'WORKER' AND ${table.assignmentId} IS NOT NULL)`,
    ),
    check('chat_membership_window_order_check', sql`${table.leftAt} IS NULL OR ${table.leftAt} >= ${table.joinedAt}`),
    check('chat_membership_created_time_check', sql`${table.createdAt} >= ${table.joinedAt}`),
    uniqueIndex('chat_membership_one_active_hirer_uidx')
      .on(table.conversationId)
      .where(sql`${table.role} = 'HIRER' AND ${table.leftAt} IS NULL`),
    index('chat_membership_member_conversation_idx')
      .on(table.memberId, table.conversationId, table.joinedAt)
      .where(sql`${table.memberId} IS NOT NULL`),
    index('chat_membership_conversation_window_idx').on(table.conversationId, table.joinedAt, table.leftAt),
  ],
);

export const chatMessage = pgTable(
  'chat_message',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id').notNull(),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    kind: chatMessageKind('kind').notNull(),
    senderMembershipId: uuid('sender_membership_id'),
    clientMessageId: varchar('client_message_id', { length: 128 }),
    contentText: varchar('content_text', { length: 4000 }),
    systemType: varchar('system_type', { length: 100 }),
    systemPayload: jsonb('system_payload').$type<Record<string, unknown> | null>(),
    eventId: varchar('event_id', { length: 255 }),
    deletedAt: time('deleted_at'),
    retentionEligibleAt: time('retention_eligible_at'),
    createdAt: time('created_at').defaultNow().notNull(),
  },
  (table) => [
    unique('chat_message_conversation_sequence_key').on(table.conversationId, table.sequence),
    foreignKey({
      name: 'chat_message_conversation_fk',
      columns: [table.conversationId],
      foreignColumns: [chatConversation.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'chat_message_sender_membership_fk',
      columns: [table.conversationId, table.senderMembershipId],
      foreignColumns: [chatMembership.conversationId, chatMembership.id],
    }).onDelete('restrict'),
    check('chat_message_sequence_check', sql`${table.sequence} > 0`),
    check('chat_message_content_text_check', sql`${table.contentText} IS NULL OR btrim(${table.contentText}) <> ''`),
    check(
      'chat_message_kind_fields_check',
      sql`(${table.kind} = 'USER' AND ${table.senderMembershipId} IS NOT NULL AND ${table.clientMessageId} IS NOT NULL AND btrim(${table.clientMessageId}) <> '' AND ${table.eventId} IS NULL AND ${table.systemType} IS NULL AND ${table.systemPayload} IS NULL) OR (${table.kind} = 'SYSTEM' AND ${table.clientMessageId} IS NULL AND ${table.eventId} IS NOT NULL AND btrim(${table.eventId}) <> '' AND ${table.systemType} IS NOT NULL AND btrim(${table.systemType}) <> '' AND ${table.systemPayload} IS NOT NULL AND jsonb_typeof(${table.systemPayload}) = 'object')`,
    ),
    check('chat_message_deleted_time_check', sql`${table.deletedAt} IS NULL OR ${table.deletedAt} >= ${table.createdAt}`),
    check(
      'chat_message_retention_time_check',
      sql`${table.retentionEligibleAt} IS NULL OR ${table.retentionEligibleAt} >= ${table.createdAt}`,
    ),
    uniqueIndex('chat_message_client_message_id_uidx')
      .on(table.senderMembershipId, table.clientMessageId)
      .where(sql`${table.kind} = 'USER'`),
    uniqueIndex('chat_message_event_id_uidx')
      .on(table.eventId)
      .where(sql`${table.kind} = 'SYSTEM'`),
    index('chat_message_conversation_created_idx').on(table.conversationId, table.createdAt, table.sequence),
    index('chat_message_retention_eligible_idx')
      .on(table.retentionEligibleAt)
      .where(sql`${table.retentionEligibleAt} IS NOT NULL`),
  ],
);

export const chatAttachment = pgTable(
  'chat_attachment',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id').notNull(),
    uploadedByMemberId: uuid('uploaded_by_member_id'),
    fileId: uuid('file_id').references(() => file.id, { onDelete: 'restrict' }),
    status: chatAttachmentStatus('status').default('QUARANTINED').notNull(),
    originalFilename: varchar('original_filename', { length: 255 }).notNull(),
    mimeType: varchar('mime_type', { length: 255 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    expiresAt: time('expires_at'),
    validatedAt: time('validated_at'),
    rejectedAt: time('rejected_at'),
    rejectionReason: varchar('rejection_reason', { length: 500 }),
    consumedAt: time('consumed_at'),
    hiddenAt: time('hidden_at'),
    deletedAt: time('deleted_at'),
    createdAt: time('created_at').defaultNow().notNull(),
    updatedAt: time('updated_at').defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: 'chat_attachment_conversation_fk',
      columns: [table.conversationId],
      foreignColumns: [chatConversation.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'chat_attachment_uploaded_by_membership_fk',
      columns: [table.conversationId, table.uploadedByMemberId],
      foreignColumns: [chatMembership.conversationId, chatMembership.id],
    }).onDelete('restrict'),
    check('chat_attachment_filename_check', sql`btrim(${table.originalFilename}) <> ''`),
    check('chat_attachment_mime_type_check', sql`btrim(${table.mimeType}) <> ''`),
    check('chat_attachment_size_check', sql`${table.sizeBytes} > 0`),
    check(
      'chat_attachment_initial_file_check',
      sql`${table.status} NOT IN ('QUARANTINED', 'REJECTED') OR ${table.fileId} IS NULL`,
    ),
    check(
      'chat_attachment_ready_file_check',
      sql`${table.status} NOT IN ('VALIDATED', 'CONSUMED', 'HIDDEN') OR ${table.fileId} IS NOT NULL`,
    ),
    check(
      'chat_attachment_rejected_fields_check',
      sql`(${table.status} = 'REJECTED' AND ${table.rejectedAt} IS NOT NULL AND ${table.rejectionReason} IS NOT NULL AND btrim(${table.rejectionReason}) <> '') OR (${table.status} <> 'REJECTED' AND ${table.rejectedAt} IS NULL AND ${table.rejectionReason} IS NULL)`,
    ),
    check(
      'chat_attachment_consumed_time_check',
      sql`${table.status} <> 'CONSUMED' OR ${table.consumedAt} IS NOT NULL`,
    ),
    check('chat_attachment_hidden_time_check', sql`${table.status} <> 'HIDDEN' OR ${table.hiddenAt} IS NOT NULL`),
    check('chat_attachment_deleted_time_check', sql`${table.deletedAt} IS NULL OR ${table.deletedAt} >= ${table.createdAt}`),
    index('chat_attachment_conversation_created_idx').on(table.conversationId, table.createdAt),
    index('chat_attachment_file_idx').on(table.fileId).where(sql`${table.fileId} IS NOT NULL`),
    index('chat_attachment_status_expiry_idx').on(table.status, table.expiresAt).where(sql`${table.expiresAt} IS NOT NULL`),
    index('chat_attachment_uploader_idx').on(table.uploadedByMemberId, table.conversationId, table.createdAt).where(sql`${table.uploadedByMemberId} IS NOT NULL`),
  ],
);

export const chatMessageAttachment = pgTable(
  'chat_message_attachment',
  {
    messageId: uuid('message_id').notNull(),
    attachmentId: uuid('attachment_id').notNull(),
    position: smallint('position').notNull(),
    attachedAt: time('attached_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.attachmentId] }),
    unique('chat_message_attachment_attachment_once_key').on(table.attachmentId),
    unique('chat_message_attachment_message_position_key').on(table.messageId, table.position),
    foreignKey({
      name: 'chat_message_attachment_message_fk',
      columns: [table.messageId],
      foreignColumns: [chatMessage.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'chat_message_attachment_attachment_fk',
      columns: [table.attachmentId],
      foreignColumns: [chatAttachment.id],
    }).onDelete('restrict'),
    check('chat_message_attachment_position_check', sql`${table.position} BETWEEN 1 AND 5`),
  ],
);

export const chatReadCursor = pgTable(
  'chat_read_cursor',
  {
    conversationId: uuid('conversation_id').notNull(),
    membershipId: uuid('membership_id').notNull(),
    lastReadSequence: bigint('last_read_sequence', { mode: 'number' }).default(0).notNull(),
    createdAt: time('created_at').defaultNow().notNull(),
    updatedAt: time('updated_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.membershipId] }),
    foreignKey({
      name: 'chat_read_cursor_membership_fk',
      columns: [table.conversationId, table.membershipId],
      foreignColumns: [chatMembership.conversationId, chatMembership.id],
    }).onDelete('restrict'),
    check('chat_read_cursor_sequence_check', sql`${table.lastReadSequence} >= 0`),
  ],
);

/** Command identity for the Quest-to-Chat transition seam. */
export const chatTransitionCommand = pgTable(
  'chat_transition_commands',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    producer: varchar('producer', { length: 64 }).notNull(),
    commandId: varchar('command_id', { length: 200 }).notNull(),
    questId: uuid('quest_id')
      .notNull()
      .references(() => quest.id, { onDelete: 'restrict' }),
    conversationId: uuid('conversation_id'),
    transitionType: varchar('transition_type', { length: 64 }).notNull(),
    requestIdentity: varchar('request_identity', { length: 64 }).notNull(),
    processingStatus: varchar('processing_status', { length: 32 }).default('PROCESSING').notNull(),
    createdAt: time('created_at').defaultNow().notNull(),
    completedAt: time('completed_at'),
  },
  (table) => [
    unique('chat_transition_commands_producer_type_command_key').on(
      table.producer,
      table.transitionType,
      table.commandId,
    ),
    foreignKey({
      name: 'chat_transition_commands_conversation_fk',
      columns: [table.conversationId],
      foreignColumns: [chatConversation.id],
    }).onDelete('restrict'),
    check(
      'chat_transition_commands_status_check',
      sql`${table.processingStatus} IN ('PROCESSING', 'COMPLETED')`,
    ),
    check(
      'chat_transition_commands_completion_check',
      sql`(${table.processingStatus} = 'COMPLETED') = (${table.completedAt} IS NOT NULL)`,
    ),
    index('chat_transition_commands_quest_id_idx').on(table.questId),
  ],
);
