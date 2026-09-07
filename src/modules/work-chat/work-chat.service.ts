import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';
import {
  chatAttachment,
  chatConversation,
  chatMembership,
  chatMessage,
  chatMessageAttachment,
  chatReadCursor,
} from '@/database/schema/work-chat.schema';
import { CursorInputError, type CursorPayload } from '@/shared/cursor';

import { and, asc, desc, eq, exists, gt, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';

import {
  UnsupportedWorkChatAttachmentError,
  WorkChatAttachmentTooLargeError,
  workChatStorage,
} from './work-chat.storage';
import { workChatDelivery, type WorkChatDeliveryMessage } from './work-chat.delivery';

type WorkChatTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type WorkChatDatabase = typeof db | WorkChatTransaction;

type MessageCursor = { sequence: number; id: string };

export class WorkChatServiceError extends Error {
  constructor(
    readonly code:
      | 'ATTACHMENT_NOT_FOUND'
      | 'ATTACHMENT_LINK_UNAVAILABLE'
      | 'ATTACHMENT_TOO_LARGE'
      | 'ATTACHMENT_UNSUPPORTED'
      | 'ATTACHMENT_UPLOAD_FAILED'
      | 'CLIENT_MESSAGE_ID_REUSED'
      | 'CONVERSATION_NOT_FOUND'
      | 'CONVERSATION_READ_ONLY'
      | 'MESSAGE_CONTENT_REQUIRED'
      | 'MESSAGE_TOO_LONG'
      | 'MESSAGE_NOT_FOUND'
      | 'RATE_LIMITED',
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'WorkChatServiceError';
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toCursor = (message: { id: string; sequence: number }): MessageCursor => ({
  id: message.id,
  sequence: message.sequence,
});

const encodeMessageCursor = (cursor: MessageCursor): string =>
  btoa(JSON.stringify({ v: 1, ...cursor }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

const decodeMessageCursor = (value: string): MessageCursor => {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid cursor');
    const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
    const parsed = JSON.parse(atob(padded)) as Record<string, unknown>;
    if (
      Object.keys(parsed).length !== 3 ||
      parsed.v !== 1 ||
      typeof parsed.sequence !== 'number' ||
      !Number.isInteger(parsed.sequence) ||
      parsed.sequence < 1 ||
      typeof parsed.id !== 'string' ||
      !uuidPattern.test(parsed.id)
    ) throw new Error('invalid cursor');
    return { sequence: parsed.sequence, id: parsed.id };
  } catch {
    throw new CursorInputError('INVALID_CURSOR', 'cursor is invalid');
  }
};

const memberCanSeeMessage = (database: WorkChatDatabase, userId: string) =>
  exists(
    database
      .select({ id: chatMembership.id })
      .from(chatMembership)
      .where(and(
        eq(chatMembership.conversationId, chatMessage.conversationId),
        eq(chatMembership.memberId, userId),
        or(isNull(chatMembership.leftAt), lte(chatMessage.createdAt, chatMembership.leftAt)),
      )),
  );

const getConversationMembership = async (
  database: WorkChatDatabase,
  userId: string,
  conversationId: string,
  currentOnly = false,
) => {
  const rows = await database
    .select({
      id: chatConversation.id,
      questId: chatConversation.questId,
      type: chatConversation.type,
      questTitle: chatConversation.questTitle,
      questStatus: chatConversation.questStatus,
      nextSequence: chatConversation.nextSequence,
      readOnlyAt: chatConversation.readOnlyAt,
      archivedAt: chatConversation.archivedAt,
      createdAt: chatConversation.createdAt,
      membershipId: chatMembership.id,
      joinedAt: chatMembership.joinedAt,
      leftAt: chatMembership.leftAt,
    })
    .from(chatConversation)
    .innerJoin(chatMembership, eq(chatMembership.conversationId, chatConversation.id))
    .where(and(
      eq(chatConversation.id, conversationId),
      eq(chatConversation.type, 'CONVERSATION_WORK'),
      isNull(chatConversation.deletedAt),
      eq(chatMembership.memberId, userId),
      inArray(chatMembership.role, ['HIRER', 'WORKER']),
      ...(currentOnly ? [isNull(chatMembership.leftAt)] : []),
    ))
    .orderBy(desc(chatMembership.joinedAt), desc(chatMembership.id))
    .limit(1);

  return rows[0];
};

export const isCurrentWorkConversationMember = async (
  userId: string,
  conversationId: string,
): Promise<boolean> => Boolean(await getConversationMembership(db, userId, conversationId, true));

export type MessageRow = {
  id: string;
  conversationId: string;
  sequence: number;
  kind: 'USER' | 'SYSTEM';
  senderMembershipId: string | null;
  contentText: string | null;
  systemType: string | null;
  systemPayload: Record<string, unknown> | null;
  eventId: string | null;
  createdAt: Date;
};

export const loadMessageDetails = async (database: WorkChatDatabase, rows: MessageRow[]) => {
  if (rows.length === 0) return [];

  const senderMembershipIds = rows
    .map(({ senderMembershipId }) => senderMembershipId)
    .filter((id): id is string => id !== null);
  const memberships = senderMembershipIds.length === 0
    ? []
    : await database
      .select({ id: chatMembership.id, memberId: chatMembership.memberId })
      .from(chatMembership)
      .where(inArray(chatMembership.id, senderMembershipIds));
  const memberIds = memberships
    .map(({ memberId }) => memberId)
    .filter((id): id is string => id !== null);
  const users = memberIds.length === 0
    ? []
    : await database
      .select({ id: authUser.id, firstName: authUser.firstName, lastName: authUser.lastName })
      .from(authUser)
      .where(inArray(authUser.id, memberIds));
  const membershipById = new Map(memberships.map((membership) => [membership.id, membership]));
  const userById = new Map(users.map((user) => [user.id, user]));

  const attachments = await database
    .select({
      messageId: chatMessageAttachment.messageId,
      id: chatAttachment.id,
      fileName: chatAttachment.originalFilename,
      mediaType: chatAttachment.mimeType,
      sizeBytes: chatAttachment.sizeBytes,
      createdAt: chatAttachment.createdAt,
    })
    .from(chatMessageAttachment)
    .innerJoin(chatAttachment, eq(chatAttachment.id, chatMessageAttachment.attachmentId))
    .where(and(
      inArray(chatMessageAttachment.messageId, rows.map(({ id }) => id)),
      eq(chatAttachment.status, 'CONSUMED'),
      isNull(chatAttachment.deletedAt),
    ))
    .orderBy(asc(chatMessageAttachment.position));
  const attachmentsByMessage = new Map<string, typeof attachments>();
  for (const attachment of attachments) {
    const current = attachmentsByMessage.get(attachment.messageId) ?? [];
    current.push(attachment);
    attachmentsByMessage.set(attachment.messageId, current);
  }

  return rows.map((row) => {
    const senderMembership = row.senderMembershipId
      ? membershipById.get(row.senderMembershipId)
      : undefined;
    const sender = row.kind === 'SYSTEM'
      ? { id: null, displayName: 'KU bot' }
      : {
          id: senderMembership?.memberId ?? null,
          displayName: senderMembership?.memberId
            ? `${userById.get(senderMembership.memberId)?.firstName ?? ''} ${userById.get(senderMembership.memberId)?.lastName ?? ''}`.trim() || 'Former member'
            : 'Former member',
        };

    return {
      id: row.id,
      conversationId: row.conversationId,
      sequence: row.sequence,
      kind: row.kind,
      sender,
      text: row.contentText,
      attachments: (attachmentsByMessage.get(row.id) ?? []).map((attachment) => ({
        id: attachment.id,
        fileName: attachment.fileName,
        mediaType: attachment.mediaType,
        sizeBytes: attachment.sizeBytes,
        createdAt: attachment.createdAt,
      })),
      systemType: row.systemType,
      systemPayload: row.systemPayload,
      eventId: row.eventId,
      createdAt: row.createdAt,
    };
  });
};

const selectVisibleMessageRows = async (
  database: WorkChatDatabase,
  userId: string,
  conversationId: string,
  options: { limit: number; before?: MessageCursor; after?: MessageCursor },
) => {
  const conditions = [
    eq(chatMessage.conversationId, conversationId),
    isNull(chatMessage.deletedAt),
    memberCanSeeMessage(database, userId),
  ];
  if (options.before) conditions.push(lt(chatMessage.sequence, options.before.sequence));
  if (options.after) conditions.push(gt(chatMessage.sequence, options.after.sequence));

  const rows = await database
    .select({
      id: chatMessage.id,
      conversationId: chatMessage.conversationId,
      sequence: chatMessage.sequence,
      kind: chatMessage.kind,
      senderMembershipId: chatMessage.senderMembershipId,
      contentText: chatMessage.contentText,
      systemType: chatMessage.systemType,
      systemPayload: chatMessage.systemPayload,
      eventId: chatMessage.eventId,
      createdAt: chatMessage.createdAt,
    })
    .from(chatMessage)
    .where(and(...conditions))
    .orderBy(options.after ? asc(chatMessage.sequence) : desc(chatMessage.sequence))
    .limit(options.limit + 1);

  return rows;
};

const validateMessageCursor = async (
  database: WorkChatDatabase,
  userId: string,
  conversationId: string,
  cursor: MessageCursor,
): Promise<void> => {
  const [message] = await database
    .select({ id: chatMessage.id })
    .from(chatMessage)
    .where(and(
      eq(chatMessage.id, cursor.id),
      eq(chatMessage.conversationId, conversationId),
      eq(chatMessage.sequence, cursor.sequence),
      isNull(chatMessage.deletedAt),
      memberCanSeeMessage(database, userId),
    ))
    .limit(1);
  if (!message) throw new CursorInputError('INVALID_CURSOR', 'cursor is invalid');
};

export type WorkConversation = {
  id: string;
  type: 'CONVERSATION_WORK';
  quest: { id: string; title: string; status: string };
  latestMessage: {
    id: string;
    kind: 'USER' | 'SYSTEM';
    preview: string;
    createdAt: Date;
  } | null;
  lastActivityAt: Date | null;
  archived: boolean;
  readOnly: boolean;
  unreadCount: number;
};

export type WorkConversationParticipant = {
  id: string | null;
  role: 'HIRER' | 'WORKER';
  displayName: string;
};

export type WorkConversationAttachment = {
  id: string;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  createdAt: Date;
};

export const listWorkConversationParticipants = async (
  userId: string,
  conversationId: string,
): Promise<WorkConversationParticipant[]> => {
  const conversation = await getConversationMembership(db, userId, conversationId);
  if (!conversation) throw new WorkChatServiceError('CONVERSATION_NOT_FOUND', 'Conversation not found');

  const participants = await db
    .select({
      id: chatMembership.memberId,
      role: chatMembership.role,
      firstName: authUser.firstName,
      lastName: authUser.lastName,
    })
    .from(chatMembership)
    .leftJoin(authUser, eq(authUser.id, chatMembership.memberId))
    .where(and(
      eq(chatMembership.conversationId, conversationId),
      inArray(chatMembership.role, ['HIRER', 'WORKER']),
      isNull(chatMembership.leftAt),
    ))
    .orderBy(asc(chatMembership.role), asc(chatMembership.joinedAt), asc(chatMembership.id));

  return participants.map((participant) => ({
    id: participant.id,
    role: participant.role as WorkConversationParticipant['role'],
    displayName: `${participant.firstName ?? ''} ${participant.lastName ?? ''}`.trim() || 'Former member',
  }));
};

const loadConversationSummary = async (
  database: WorkChatDatabase,
  userId: string,
  conversation: NonNullable<Awaited<ReturnType<typeof getConversationMembership>>>,
): Promise<WorkConversation> => {
  const rows = await selectVisibleMessageRows(database, userId, conversation.id, { limit: 1 });
  const latestRows = rows.slice(0, 1);
  const latest = (await loadMessageDetails(database, latestRows))[0];
  const [readCursor] = await database
    .select({ lastReadSequence: chatReadCursor.lastReadSequence })
    .from(chatReadCursor)
    .where(and(
      eq(chatReadCursor.conversationId, conversation.id),
      eq(chatReadCursor.membershipId, conversation.membershipId),
    ))
    .limit(1);
  const [unread] = await database
    .select({ count: sql<number>`count(*)` })
    .from(chatMessage)
    .where(and(
      eq(chatMessage.conversationId, conversation.id),
      isNull(chatMessage.deletedAt),
      gt(chatMessage.sequence, readCursor?.lastReadSequence ?? 0),
      memberCanSeeMessage(database, userId),
    ));

  return {
    id: conversation.id,
    type: 'CONVERSATION_WORK',
    quest: {
      id: conversation.questId,
      title: conversation.questTitle,
      status: conversation.questStatus,
    },
    latestMessage: latest
      ? {
          id: latest.id,
          kind: latest.kind,
          preview: latest.text ?? '',
          createdAt: latest.createdAt,
        }
      : null,
    lastActivityAt: latest?.createdAt ?? null,
    archived: conversation.archivedAt !== null,
    readOnly: conversation.readOnlyAt !== null,
    unreadCount: Number(unread?.count ?? 0),
  };
};

export const listWorkConversations = async (
  userId: string,
  options: { limit: number; cursor?: CursorPayload },
) => {
  // Page by the caller-visible activity in SQL. This keeps the summary work bounded
  // by the requested page instead of loading every Conversation before slicing it.
  const lastActivityAt = sql`coalesce(max(${chatMessage.createdAt}), timestamp 'epoch')`;
  const cursor = options.cursor;
  const candidates = await db
    .select({ conversationId: chatMembership.conversationId })
    .from(chatMembership)
    .innerJoin(chatConversation, eq(chatConversation.id, chatMembership.conversationId))
    .leftJoin(chatMessage, and(
      eq(chatMessage.conversationId, chatConversation.id),
      isNull(chatMessage.deletedAt),
      memberCanSeeMessage(db, userId),
    ))
    .where(and(
      eq(chatMembership.memberId, userId),
      inArray(chatMembership.role, ['HIRER', 'WORKER']),
      eq(chatConversation.type, 'CONVERSATION_WORK'),
      isNull(chatConversation.deletedAt),
    ))
    .groupBy(chatMembership.conversationId)
    .having(cursor
      ? or(
          lt(lastActivityAt, new Date(cursor.startTime)),
          and(eq(lastActivityAt, new Date(cursor.startTime)), lt(chatMembership.conversationId, cursor.id)),
        )
      : undefined)
    .orderBy(desc(lastActivityAt), desc(chatMembership.conversationId))
    .limit(options.limit + 1);

  const conversations = await Promise.all(
    candidates.slice(0, options.limit).map(async ({ conversationId }) => {
      const membership = await getConversationMembership(db, userId, conversationId);
      return membership ? loadConversationSummary(db, userId, membership) : null;
    }),
  );
  const sorted = conversations
    .filter((conversation): conversation is WorkConversation => conversation !== null)
    .sort((left, right) => {
      const leftTime = left.lastActivityAt?.getTime() ?? 0;
      const rightTime = right.lastActivityAt?.getTime() ?? 0;
      if (rightTime !== leftTime) return rightTime - leftTime;
      return right.id > left.id ? 1 : right.id < left.id ? -1 : 0;
    });
  const page = sorted;
  const hasMore = candidates.length > page.length;
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: hasMore && last
      ? { startTime: (last.lastActivityAt ?? new Date(0)).toISOString(), id: last.id }
      : null,
  };
};

export const listWorkConversationMessages = async (
  userId: string,
  conversationId: string,
  options: { limit: number; before?: string; after?: string },
) => {
  const conversation = await getConversationMembership(db, userId, conversationId);
  if (!conversation) throw new WorkChatServiceError('CONVERSATION_NOT_FOUND', 'Conversation not found');
  const before = options.before ? decodeMessageCursor(options.before) : undefined;
  const after = options.after ? decodeMessageCursor(options.after) : undefined;
  if (before) await validateMessageCursor(db, userId, conversationId, before);
  if (after) await validateMessageCursor(db, userId, conversationId, after);

  const rows = await selectVisibleMessageRows(db, userId, conversationId, { limit: options.limit, before, after });
  const hasMore = rows.length > options.limit;
  const selectedRows = rows.slice(0, options.limit);
  if (!after) selectedRows.reverse();
  const items = await loadMessageDetails(db, selectedRows);
  const cursorMessage = after ? selectedRows[selectedRows.length - 1] : selectedRows[0];

  return {
    items,
    hasMore,
    nextCursor: hasMore && cursorMessage ? encodeMessageCursor(toCursor(cursorMessage)) : null,
  };
};

const attachmentIdsForMessage = async (database: WorkChatDatabase, messageId: string) => {
  const rows = await database
    .select({ id: chatMessageAttachment.attachmentId })
    .from(chatMessageAttachment)
    .where(eq(chatMessageAttachment.messageId, messageId))
    .orderBy(asc(chatMessageAttachment.position));
  return rows.map(({ id }) => id);
};

const maxMessagesPerMinute = 30;
const maxAttachmentsPerMinute = 10;
const rateLimitWindowMs = 60_000;

const retryAfterSeconds = (createdAt: Date, now = Date.now()): number => Math.max(
  1,
  Math.ceil((createdAt.getTime() + rateLimitWindowMs - now) / 1000),
);

const enforceSendRateLimit = async (
  database: WorkChatDatabase,
  userId: string,
  questId: string,
  requestedAttachmentCount: number,
): Promise<void> => {
  const windowStart = new Date(Date.now() - rateLimitWindowMs);
  const recentMessages = await database
    .select({ createdAt: chatMessage.createdAt })
    .from(chatMessage)
    .innerJoin(chatConversation, eq(chatConversation.id, chatMessage.conversationId))
    .innerJoin(chatMembership, eq(chatMembership.id, chatMessage.senderMembershipId!))
    .where(and(
      eq(chatConversation.questId, questId),
      eq(chatMessage.kind, 'USER'),
      eq(chatMembership.memberId, userId),
      gte(chatMessage.createdAt, windowStart),
    ))
    .orderBy(asc(chatMessage.createdAt));
  const recentAttachments = await database
    .select({ createdAt: chatMessage.createdAt })
    .from(chatMessageAttachment)
    .innerJoin(chatMessage, eq(chatMessage.id, chatMessageAttachment.messageId))
    .innerJoin(chatConversation, eq(chatConversation.id, chatMessage.conversationId))
    .innerJoin(chatMembership, eq(chatMembership.id, chatMessage.senderMembershipId!))
    .where(and(
      eq(chatConversation.questId, questId),
      eq(chatMessage.kind, 'USER'),
      eq(chatMembership.memberId, userId),
      gte(chatMessage.createdAt, windowStart),
    ))
    .orderBy(asc(chatMessage.createdAt));

  const retryTimes: number[] = [];
  if (recentMessages.length >= maxMessagesPerMinute && recentMessages[0]) {
    retryTimes.push(retryAfterSeconds(recentMessages[0].createdAt));
  }
  const attachmentsToExpire = Math.max(
    0,
    recentAttachments.length + requestedAttachmentCount - maxAttachmentsPerMinute,
  );
  if (attachmentsToExpire > 0 && recentAttachments[attachmentsToExpire - 1]) {
    retryTimes.push(retryAfterSeconds(recentAttachments[attachmentsToExpire - 1].createdAt));
  }
  if (retryTimes.length > 0) {
    throw new WorkChatServiceError(
      'RATE_LIMITED',
      'Work Chat rate limit exceeded',
      Math.max(...retryTimes),
    );
  }
};

const mapAttachmentStorageError = (error: unknown): WorkChatServiceError => {
  if (error instanceof WorkChatAttachmentTooLargeError) {
    return new WorkChatServiceError('ATTACHMENT_TOO_LARGE', error.message);
  }
  if (error instanceof UnsupportedWorkChatAttachmentError) {
    return new WorkChatServiceError('ATTACHMENT_UNSUPPORTED', error.message);
  }
  return new WorkChatServiceError('ATTACHMENT_UPLOAD_FAILED', 'Attachment upload failed');
};

export const uploadWorkConversationAttachment = async (
  userId: string,
  conversationId: string,
  upload: File,
): Promise<WorkConversationAttachment> => {
  const visibleConversation = await getConversationMembership(db, userId, conversationId, true);
  if (!visibleConversation) throw new WorkChatServiceError('CONVERSATION_NOT_FOUND', 'Conversation not found');
  if (visibleConversation.readOnlyAt) {
    throw new WorkChatServiceError('CONVERSATION_READ_ONLY', 'Conversation is read-only');
  }

  let stored: Awaited<ReturnType<typeof workChatStorage.upload>>;
  try {
    stored = await workChatStorage.upload(userId, upload);
  } catch (error) {
    throw mapAttachmentStorageError(error);
  }

  try {
    return await db.transaction(async (transaction) => {
      const [lockedConversation] = await transaction
        .select({ id: chatConversation.id, readOnlyAt: chatConversation.readOnlyAt })
        .from(chatConversation)
        .where(and(
          eq(chatConversation.id, conversationId),
          isNull(chatConversation.deletedAt),
        ))
        .limit(1)
        .for('update');
      if (!lockedConversation) throw new WorkChatServiceError('CONVERSATION_NOT_FOUND', 'Conversation not found');

      const conversation = await getConversationMembership(transaction, userId, conversationId, true);
      if (!conversation) throw new WorkChatServiceError('CONVERSATION_NOT_FOUND', 'Conversation not found');
      if (lockedConversation.readOnlyAt) {
        throw new WorkChatServiceError('CONVERSATION_READ_ONLY', 'Conversation is read-only');
      }

      const windowStart = new Date(Date.now() - rateLimitWindowMs);
      const recent = await transaction
        .select({ createdAt: chatAttachment.createdAt })
        .from(chatAttachment)
        .innerJoin(chatMembership, eq(chatMembership.id, chatAttachment.uploadedByMemberId!))
        .innerJoin(chatConversation, eq(chatConversation.id, chatAttachment.conversationId))
        .where(and(
          eq(chatConversation.questId, conversation.questId),
          eq(chatMembership.memberId, userId),
          gte(chatAttachment.createdAt, windowStart),
        ))
        .orderBy(asc(chatAttachment.createdAt));
      if (recent.length >= maxAttachmentsPerMinute && recent[0]) {
        throw new WorkChatServiceError(
          'RATE_LIMITED',
          'Work Chat rate limit exceeded',
          retryAfterSeconds(recent[0].createdAt),
        );
      }

      const [storedFile] = await transaction
        .insert(file)
        .values({
          bucket: stored.bucket,
          objectKey: stored.objectKey,
          contentType: stored.contentType,
          sizeBytes: stored.sizeBytes,
          uploadedByUserId: userId,
        })
        .returning({ id: file.id });
      if (!storedFile) throw new Error('Work Chat attachment file could not be stored');

      const [attachment] = await transaction
        .insert(chatAttachment)
        .values({
          conversationId,
          uploadedByMemberId: conversation.membershipId,
          fileId: storedFile.id,
          status: 'VALIDATED',
          originalFilename: stored.fileName,
          mimeType: stored.contentType,
          sizeBytes: stored.sizeBytes,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          validatedAt: new Date(),
        })
        .returning({
          id: chatAttachment.id,
          fileName: chatAttachment.originalFilename,
          mediaType: chatAttachment.mimeType,
          sizeBytes: chatAttachment.sizeBytes,
          createdAt: chatAttachment.createdAt,
        });
      if (!attachment) throw new Error('Work Chat attachment could not be stored');
      return attachment;
    });
  } catch (error) {
    try {
      await workChatStorage.remove(stored);
    } catch (cleanupError) {
      console.error('[work-chat-attachment-upload] Compensating object deletion failed', {
        bucket: stored.bucket,
        cleanupError,
        objectKey: stored.objectKey,
      });
    }
    throw error;
  }
};

type WorkChatAttachmentObject = {
  id: string;
  bucket: string;
  objectKey: string;
};

const deleteWorkChatAttachmentObject = async (attachment: WorkChatAttachmentObject): Promise<boolean> => {
  try {
    await workChatStorage.remove(attachment);
    await db
      .update(chatAttachment)
      .set({ objectDeletedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(chatAttachment.id, attachment.id),
        eq(chatAttachment.status, 'EXPIRED'),
        isNull(chatAttachment.objectDeletedAt),
      ));
    return true;
  } catch (error) {
    console.error('[work-chat-attachment-cleanup] Object deletion failed', {
      attachmentId: attachment.id,
      bucket: attachment.bucket,
      objectKey: attachment.objectKey,
      error,
    });
    return false;
  }
};

export const discardWorkConversationAttachment = async (
  userId: string,
  conversationId: string,
  attachmentId: string,
): Promise<{ attachmentId: string }> => {
  const attachment = await db.transaction(async (transaction) => {
    const conversation = await getConversationMembership(transaction, userId, conversationId, true);
    if (!conversation) {
      throw new WorkChatServiceError('CONVERSATION_NOT_FOUND', 'Conversation not found');
    }
    if (conversation.readOnlyAt) throw new WorkChatServiceError('CONVERSATION_READ_ONLY', 'Conversation is read-only');

    const [storedAttachment] = await transaction
      .select({
        id: chatAttachment.id,
        fileId: chatAttachment.fileId,
        bucket: file.bucket,
        objectKey: file.objectKey,
      })
      .from(chatAttachment)
      .innerJoin(file, eq(file.id, chatAttachment.fileId))
      .where(and(
        eq(chatAttachment.id, attachmentId),
        eq(chatAttachment.conversationId, conversationId),
        eq(chatAttachment.uploadedByMemberId, conversation.membershipId),
        eq(chatAttachment.status, 'VALIDATED'),
        isNull(chatAttachment.deletedAt),
      ))
      .limit(1)
      .for('update');
    if (!storedAttachment) throw new WorkChatServiceError('ATTACHMENT_NOT_FOUND', 'Attachment not found');

    const [messageAttachment] = await transaction
      .select({ attachmentId: chatMessageAttachment.attachmentId })
      .from(chatMessageAttachment)
      .where(eq(chatMessageAttachment.attachmentId, attachmentId))
      .limit(1);
    if (messageAttachment) throw new WorkChatServiceError('ATTACHMENT_NOT_FOUND', 'Attachment not found');

    const deletedAt = new Date();
    await transaction
      .update(chatAttachment)
      .set({ status: 'EXPIRED', deletedAt, expiresAt: deletedAt, updatedAt: deletedAt })
      .where(eq(chatAttachment.id, attachmentId));
    await transaction
      .update(file)
      .set({ deletedAt })
      .where(eq(file.id, storedAttachment.fileId!));

    return storedAttachment;
  });

  await deleteWorkChatAttachmentObject(attachment);
  return { attachmentId: attachment.id };
};

export const cleanupExpiredWorkChatAttachments = async (now = new Date()): Promise<number> => {
  const expired = await db
    .select({
      id: chatAttachment.id,
      bucket: file.bucket,
      objectKey: file.objectKey,
    })
    .from(chatAttachment)
    .innerJoin(file, eq(file.id, chatAttachment.fileId))
    .where(and(
      eq(chatAttachment.status, 'EXPIRED'),
      isNull(chatAttachment.objectDeletedAt),
      or(isNull(chatAttachment.expiresAt), lte(chatAttachment.expiresAt, now)),
    ));

  const results = await Promise.all(expired.map((attachment) => deleteWorkChatAttachmentObject(attachment)));
  return results.filter(Boolean).length;
};

export const getWorkConversationAttachmentLink = async (
  userId: string,
  conversationId: string,
  attachmentId: string,
) => {
  const conversation = await getConversationMembership(db, userId, conversationId);
  if (!conversation) throw new WorkChatServiceError('CONVERSATION_NOT_FOUND', 'Conversation not found');

  const [attachment] = await db
    .select({
      id: chatAttachment.id,
      bucket: file.bucket,
      objectKey: file.objectKey,
    })
    .from(chatAttachment)
    .innerJoin(file, eq(file.id, chatAttachment.fileId))
    .innerJoin(chatMessageAttachment, eq(chatMessageAttachment.attachmentId, chatAttachment.id))
    .innerJoin(chatMessage, eq(chatMessage.id, chatMessageAttachment.messageId))
    .where(and(
      eq(chatAttachment.id, attachmentId),
      eq(chatAttachment.conversationId, conversationId),
      eq(chatAttachment.status, 'CONSUMED'),
      isNull(chatAttachment.deletedAt),
      isNull(chatMessage.deletedAt),
      memberCanSeeMessage(db, userId),
    ))
    .limit(1);
  if (!attachment) throw new WorkChatServiceError('ATTACHMENT_NOT_FOUND', 'Attachment not found');

  try {
    return {
      attachmentId: attachment.id,
      ...workChatStorage.linkFor(attachment),
    };
  } catch {
    throw new WorkChatServiceError('ATTACHMENT_LINK_UNAVAILABLE', 'Attachment link is unavailable');
  }
};

export const sendWorkConversationMessage = async (
  userId: string,
  conversationId: string,
  input: { clientMessageId: string; text?: string; attachmentIds?: string[] },
): Promise<Awaited<ReturnType<typeof loadMessageDetails>>[number]> => {
  const result = await db.transaction(async (transaction) => {
  const [lockedConversation] = await transaction
    .select({
      id: chatConversation.id,
      nextSequence: chatConversation.nextSequence,
      readOnlyAt: chatConversation.readOnlyAt,
    })
    .from(chatConversation)
    .where(and(
      eq(chatConversation.id, conversationId),
      isNull(chatConversation.deletedAt),
    ))
    .limit(1)
    .for('update');
  if (!lockedConversation) throw new WorkChatServiceError('CONVERSATION_NOT_FOUND', 'Conversation not found');

  const conversation = await getConversationMembership(transaction, userId, conversationId, true);
  if (!conversation) throw new WorkChatServiceError('CONVERSATION_NOT_FOUND', 'Conversation not found');

  const text = input.text?.trim();
  const attachmentIds = input.attachmentIds ?? [];
  if (!text && attachmentIds.length === 0) {
    throw new WorkChatServiceError('MESSAGE_CONTENT_REQUIRED', 'Message text or an Attachment is required');
  }
  if (text && text.length > 1000) {
    throw new WorkChatServiceError('MESSAGE_TOO_LONG', 'Message text must be 1,000 characters or fewer');
  }

  const [existing] = await transaction
    .select({
      id: chatMessage.id,
      conversationId: chatMessage.conversationId,
      sequence: chatMessage.sequence,
      kind: chatMessage.kind,
      senderMembershipId: chatMessage.senderMembershipId,
      contentText: chatMessage.contentText,
      systemType: chatMessage.systemType,
      systemPayload: chatMessage.systemPayload,
      eventId: chatMessage.eventId,
      createdAt: chatMessage.createdAt,
    })
    .from(chatMessage)
    .innerJoin(chatMembership, eq(chatMembership.id, chatMessage.senderMembershipId!))
    .where(and(
      eq(chatMessage.conversationId, conversationId),
      eq(chatMessage.kind, 'USER'),
      eq(chatMessage.clientMessageId, input.clientMessageId),
      eq(chatMembership.memberId, userId),
    ))
    .limit(1)
    .for('update');
  if (existing) {
    const existingAttachmentIds = await attachmentIdsForMessage(transaction, existing.id);
    if (existing.contentText !== (text ?? null) || existingAttachmentIds.join(',') !== attachmentIds.join(',')) {
      throw new WorkChatServiceError('CLIENT_MESSAGE_ID_REUSED', 'The client Message identifier was used for different content');
    }
    return {
      message: (await loadMessageDetails(transaction, [existing]))[0]!,
      created: false,
    };
  }

  if (lockedConversation.readOnlyAt) {
    throw new WorkChatServiceError('CONVERSATION_READ_ONLY', 'Conversation is read-only');
  }

  await enforceSendRateLimit(transaction, userId, conversation.questId, attachmentIds.length);

  let attachments: Array<{ id: string }> = [];
  if (attachmentIds.length > 0) {
    const selectedAttachments = await transaction
      .select({ id: chatAttachment.id })
      .from(chatAttachment)
      .where(and(
        inArray(chatAttachment.id, attachmentIds),
        eq(chatAttachment.conversationId, conversationId),
        eq(chatAttachment.uploadedByMemberId, conversation.membershipId),
        eq(chatAttachment.status, 'VALIDATED'),
        ))
      .for('update');
    if (selectedAttachments.length !== attachmentIds.length) {
      throw new WorkChatServiceError('ATTACHMENT_NOT_FOUND', 'Attachment not found');
    }
    const selectedById = new Map(selectedAttachments.map((attachment) => [attachment.id, attachment]));
    for (const attachmentId of attachmentIds) {
      const attachment = selectedById.get(attachmentId);
      if (!attachment) throw new WorkChatServiceError('ATTACHMENT_NOT_FOUND', 'Attachment not found');
      attachments.push(attachment);
    }
  }

  const createdAt = new Date();
  const [message] = await transaction
    .insert(chatMessage)
    .values({
      conversationId,
      sequence: lockedConversation.nextSequence,
      kind: 'USER',
      senderMembershipId: conversation.membershipId,
      clientMessageId: input.clientMessageId,
      contentText: text ?? null,
      createdAt,
    })
    .returning({
      id: chatMessage.id,
      conversationId: chatMessage.conversationId,
      sequence: chatMessage.sequence,
      kind: chatMessage.kind,
      senderMembershipId: chatMessage.senderMembershipId,
      contentText: chatMessage.contentText,
      systemType: chatMessage.systemType,
      systemPayload: chatMessage.systemPayload,
      eventId: chatMessage.eventId,
      createdAt: chatMessage.createdAt,
    });
  if (!message) throw new Error('Work Chat Message could not be stored');

  if (attachments.length > 0) {
    await transaction.insert(chatMessageAttachment).values(attachments.map((attachment, index) => ({
      messageId: message.id,
      attachmentId: attachment.id,
      position: index + 1,
    })));
    await transaction
      .update(chatAttachment)
      .set({ status: 'CONSUMED', consumedAt: createdAt, expiresAt: null, updatedAt: createdAt })
      .where(inArray(chatAttachment.id, attachmentIds));
  }
  await transaction
    .update(chatConversation)
    .set({ nextSequence: sql`${chatConversation.nextSequence} + 1`, updatedAt: createdAt })
    .where(eq(chatConversation.id, conversationId));

  return {
    message: (await loadMessageDetails(transaction, [message]))[0]!,
    created: true,
  };
  });

  if (result.created) {
    try {
      const recipientRows = await db
        .select({ memberId: chatMembership.memberId })
        .from(chatMembership)
        .where(and(
          eq(chatMembership.conversationId, conversationId),
          isNull(chatMembership.leftAt),
        ));
      const recipientMemberIds = recipientRows
        .map(({ memberId }) => memberId)
        .filter((memberId): memberId is string => memberId !== null && memberId !== userId);
      await workChatDelivery.publish({
        message: result.message as WorkChatDeliveryMessage,
        recipientMemberIds,
      });
    } catch (error) {
      console.error('[work-chat-delivery] Post-commit publication failed', {
        conversationId,
        messageId: result.message.id,
        error,
      });
    }
  }

  return result.message;
};

export const advanceWorkConversationReadCursor = async (
  userId: string,
  conversationId: string,
  messageId: string,
) => db.transaction(async (transaction) => {
  const conversation = await getConversationMembership(transaction, userId, conversationId);
  if (!conversation) throw new WorkChatServiceError('CONVERSATION_NOT_FOUND', 'Conversation not found');
  const [message] = await transaction
    .select({ id: chatMessage.id, sequence: chatMessage.sequence })
    .from(chatMessage)
    .where(and(
      eq(chatMessage.id, messageId),
      eq(chatMessage.conversationId, conversationId),
      isNull(chatMessage.deletedAt),
      memberCanSeeMessage(transaction, userId),
    ))
    .limit(1);
  if (!message) throw new WorkChatServiceError('MESSAGE_NOT_FOUND', 'Message not found');

  await transaction
    .insert(chatReadCursor)
    .values({
      conversationId,
      membershipId: conversation.membershipId,
      lastReadSequence: message.sequence,
    })
    .onConflictDoUpdate({
      target: [chatReadCursor.conversationId, chatReadCursor.membershipId],
      set: {
        lastReadSequence: sql`GREATEST(${chatReadCursor.lastReadSequence}, ${message.sequence})`,
        updatedAt: new Date(),
      },
    });

  const [storedCursor] = await transaction
    .select({ lastReadSequence: chatReadCursor.lastReadSequence })
    .from(chatReadCursor)
    .where(and(
      eq(chatReadCursor.conversationId, conversationId),
      eq(chatReadCursor.membershipId, conversation.membershipId),
    ))
    .limit(1);
  const storedSequence = storedCursor?.lastReadSequence ?? message.sequence;

  const [storedMessage] = await transaction
    .select({ id: chatMessage.id })
    .from(chatMessage)
    .where(and(
      eq(chatMessage.conversationId, conversationId),
      eq(chatMessage.sequence, storedSequence),
      isNull(chatMessage.deletedAt),
      memberCanSeeMessage(transaction, userId),
    ))
    .limit(1);
  if (!storedMessage) throw new WorkChatServiceError('MESSAGE_NOT_FOUND', 'Message not found');
  return { conversationId, messageId: storedMessage.id };
});
