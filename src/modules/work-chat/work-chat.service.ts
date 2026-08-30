import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import {
  chatAttachment,
  chatConversation,
  chatMembership,
  chatMessage,
  chatMessageAttachment,
  chatReadCursor,
} from '@/database/schema/work-chat.schema';
import { CursorInputError, type CursorPayload } from '@/shared/cursor';

import { and, asc, desc, eq, exists, gt, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';

type WorkChatTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type WorkChatDatabase = typeof db | WorkChatTransaction;

type MessageCursor = { sequence: number; id: string };

export class WorkChatServiceError extends Error {
  constructor(
    readonly code:
      | 'ATTACHMENT_NOT_FOUND'
      | 'CLIENT_MESSAGE_ID_REUSED'
      | 'CONVERSATION_NOT_FOUND'
      | 'CONVERSATION_READ_ONLY'
      | 'MESSAGE_CONTENT_REQUIRED'
      | 'MESSAGE_NOT_FOUND',
    message: string,
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
      isNull(chatConversation.deletedAt),
      eq(chatMembership.memberId, userId),
      ...(currentOnly ? [isNull(chatMembership.leftAt)] : []),
    ))
    .orderBy(desc(chatMembership.joinedAt), desc(chatMembership.id))
    .limit(1);

  return rows[0];
};

type MessageRow = {
  id: string;
  conversationId: string;
  sequence: number;
  kind: 'USER' | 'SYSTEM';
  senderMembershipId: string | null;
  contentText: string | null;
  systemType: string | null;
  createdAt: Date;
};

const loadMessageDetails = async (database: WorkChatDatabase, rows: MessageRow[]) => {
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
      ? null
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
  const memberships = await db
    .select({ conversationId: chatMembership.conversationId, joinedAt: chatMembership.joinedAt })
    .from(chatMembership)
    .innerJoin(chatConversation, eq(chatConversation.id, chatMembership.conversationId))
    .where(and(
      eq(chatMembership.memberId, userId),
      isNull(chatConversation.deletedAt),
    ))
    .orderBy(desc(chatMembership.joinedAt));
  const latestMembershipByConversation = new Map<string, typeof memberships[number]>();
  for (const membership of memberships) {
    if (!latestMembershipByConversation.has(membership.conversationId)) {
      latestMembershipByConversation.set(membership.conversationId, membership);
    }
  }

  const conversations = await Promise.all(
    [...latestMembershipByConversation.values()].map(async ({ conversationId }) => {
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
  const filtered = options.cursor
    ? sorted.filter((conversation) => {
        const activity = conversation.lastActivityAt?.toISOString() ?? new Date(0).toISOString();
        return activity < options.cursor!.startTime ||
          (activity === options.cursor!.startTime && conversation.id < options.cursor!.id);
      })
    : sorted;
  const page = filtered.slice(0, options.limit);
  const hasMore = filtered.length > page.length;
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

export const sendWorkConversationMessage = async (
  userId: string,
  conversationId: string,
  input: { clientMessageId: string; text?: string; attachmentIds?: string[] },
) => db.transaction(async (transaction) => {
  const conversation = await getConversationMembership(transaction, userId, conversationId, true);
  if (!conversation) throw new WorkChatServiceError('CONVERSATION_NOT_FOUND', 'Conversation not found');

  const text = input.text?.trim();
  const attachmentIds = input.attachmentIds ?? [];
  if (!text && attachmentIds.length === 0) {
    throw new WorkChatServiceError('MESSAGE_CONTENT_REQUIRED', 'Message text or an Attachment is required');
  }

  const [lockedConversation] = await transaction
    .select({
      nextSequence: chatConversation.nextSequence,
      readOnlyAt: chatConversation.readOnlyAt,
    })
    .from(chatConversation)
    .where(eq(chatConversation.id, conversationId))
    .limit(1)
    .for('update');
  if (!lockedConversation) throw new WorkChatServiceError('CONVERSATION_NOT_FOUND', 'Conversation not found');

  const [existing] = await transaction
    .select({
      id: chatMessage.id,
      conversationId: chatMessage.conversationId,
      sequence: chatMessage.sequence,
      kind: chatMessage.kind,
      senderMembershipId: chatMessage.senderMembershipId,
      contentText: chatMessage.contentText,
      systemType: chatMessage.systemType,
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
    return (await loadMessageDetails(transaction, [existing]))[0]!;
  }

  if (lockedConversation.readOnlyAt) {
    throw new WorkChatServiceError('CONVERSATION_READ_ONLY', 'Conversation is read-only');
  }

  let attachments: Array<{ id: string }> = [];
  if (attachmentIds.length > 0) {
    attachments = await transaction
      .select({ id: chatAttachment.id })
      .from(chatAttachment)
      .where(and(
        inArray(chatAttachment.id, attachmentIds),
        eq(chatAttachment.conversationId, conversationId),
        eq(chatAttachment.uploadedByMemberId, conversation.membershipId),
        eq(chatAttachment.status, 'VALIDATED'),
        isNull(chatAttachment.deletedAt),
      ));
    if (attachments.length !== attachmentIds.length) {
      throw new WorkChatServiceError('ATTACHMENT_NOT_FOUND', 'Attachment not found');
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
      .set({ status: 'CONSUMED', consumedAt: createdAt, updatedAt: createdAt })
      .where(inArray(chatAttachment.id, attachmentIds));
  }
  await transaction
    .update(chatConversation)
    .set({ nextSequence: sql`${chatConversation.nextSequence} + 1`, updatedAt: createdAt })
    .where(eq(chatConversation.id, conversationId));

  return (await loadMessageDetails(transaction, [message]))[0]!;
});

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
