import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';
import { quest, questAssignment } from '@/database/schema/quest.schema';
import {
  chatAttachment,
  chatConversation,
  chatMembership,
  chatMessage,
  chatMessageAttachment,
  chatReadCursor,
} from '@/database/schema/work-chat.schema';
import { CursorInputError, type CursorPayload } from '@/shared/cursor';

import { and, asc, desc, eq, gte, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';

import { workChatDelivery } from './work-chat.delivery';
import {
  UnsupportedWorkChatAttachmentError,
  WorkChatAttachmentTooLargeError,
  workChatStorage,
} from './work-chat.storage';
import { loadMessageDetails, type MessageRow } from './work-chat.service';

type CandidateInquiryDatabase = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
type MessageCursor = { sequence: number; id: string };

export class CandidateInquiryServiceError extends Error {
  constructor(
    readonly code:
      | 'ATTACHMENT_LINK_UNAVAILABLE'
      | 'ATTACHMENT_NOT_FOUND'
      | 'ATTACHMENT_TOO_LARGE'
      | 'ATTACHMENT_UNSUPPORTED'
      | 'ATTACHMENT_UPLOAD_FAILED'
      | 'ATTACHMENTS_TOO_MANY'
      | 'CLIENT_MESSAGE_ID_REUSED'
      | 'CONVERSATION_NOT_FOUND'
      | 'INQUIRY_CLOSED'
      | 'INQUIRY_NOT_AVAILABLE'
      | 'MESSAGE_CONTENT_REQUIRED'
      | 'MESSAGE_NOT_FOUND'
      | 'MESSAGE_TOO_LONG'
      | 'RATE_LIMITED',
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'CandidateInquiryServiceError';
  }
}

const maxMessagesPerMinute = 30;
const maxAttachmentsPerMinute = 10;
const maxAttachmentsPerMessage = 5;
const rateLimitWindowMs = 60_000;
const preparedAttachmentLifetimeMs = 24 * 60 * 60 * 1000;

const retryAfterSeconds = (createdAt: Date, now = Date.now()): number => Math.max(
  1,
  Math.ceil((createdAt.getTime() + rateLimitWindowMs - now) / 1000),
);

const getCandidateInquiryMembership = async (
  database: CandidateInquiryDatabase,
  userId: string,
  conversationId: string,
) => {
  const rows = await database
    .select({
      id: chatConversation.id,
      questId: chatConversation.questId,
      type: chatConversation.type,
      state: chatConversation.state,
      candidateWorkerId: chatConversation.candidateWorkerId,
      questTitle: chatConversation.questTitle,
      questStatus: chatConversation.questStatus,
      nextSequence: chatConversation.nextSequence,
      closedAt: chatConversation.closedAt,
      membershipId: chatMembership.id,
      joinedAt: chatMembership.joinedAt,
      leftAt: chatMembership.leftAt,
    })
    .from(chatConversation)
    .innerJoin(quest, eq(quest.id, chatConversation.questId))
    .innerJoin(chatMembership, eq(chatMembership.conversationId, chatConversation.id))
    .where(and(
      eq(chatConversation.id, conversationId),
      eq(chatConversation.type, 'CONVERSATION_CANDIDATE_INQUIRY'),
      eq(chatConversation.state, 'INQUIRY_OPEN'),
      isNull(chatConversation.deletedAt),
      eq(quest.questStatus, 'QUEST_OPEN'),
      isNull(quest.hiddenAt),
      eq(chatMembership.memberId, userId),
      or(
        and(eq(chatMembership.role, 'HIRER'), eq(chatMembership.memberId, quest.hirerId)),
        and(eq(chatMembership.role, 'PROSPECTIVE_WORKER'), eq(chatMembership.memberId, chatConversation.candidateWorkerId)),
      ),
      isNull(chatMembership.leftAt),
    ))
    .limit(1);
  return rows[0];
};

const messageFields = {
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
};

const loadCandidateMessageRows = async (
  database: CandidateInquiryDatabase,
  conversationId: string,
  options: { limit: number; before?: MessageCursor; after?: MessageCursor },
): Promise<MessageRow[]> => {
  const conditions = [
    eq(chatMessage.conversationId, conversationId),
    isNull(chatMessage.deletedAt),
  ];
  if (options.before) conditions.push(lt(chatMessage.sequence, options.before.sequence));
  if (options.after) conditions.push(gt(chatMessage.sequence, options.after.sequence));

  return database
    .select(messageFields)
    .from(chatMessage)
    .where(and(...conditions))
    .orderBy(options.after ? asc(chatMessage.sequence) : desc(chatMessage.sequence))
    .limit(options.limit + 1);
};

const encodeMessageCursor = (cursor: MessageCursor): string =>
  btoa(JSON.stringify({ v: 1, ...cursor }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

const validateMessageCursor = async (
  database: CandidateInquiryDatabase,
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
    ))
    .limit(1);
  if (!message) throw new CursorInputError('INVALID_CURSOR', 'cursor is invalid');
};

export type CandidateInquiryParticipant = {
  id: string | null;
  role: 'HIRER' | 'PROSPECTIVE_WORKER';
  displayName: string;
};

const loadCandidateParticipants = async (
  database: CandidateInquiryDatabase,
  conversationId: string,
): Promise<CandidateInquiryParticipant[]> => {
  const rows = await database
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
      inArray(chatMembership.role, ['HIRER', 'PROSPECTIVE_WORKER']),
      isNull(chatMembership.leftAt),
    ))
    .orderBy(asc(chatMembership.role), asc(chatMembership.joinedAt), asc(chatMembership.id));

  return rows.map((row) => ({
    id: row.id,
    role: row.role as CandidateInquiryParticipant['role'],
    displayName: `${row.firstName ?? ''} ${row.lastName ?? ''}`.trim() || 'Former member',
  }));
};

export type CandidateInquiry = {
  id: string;
  type: 'CONVERSATION_CANDIDATE_INQUIRY';
  state: 'INQUIRY_OPEN';
  quest: { id: string; title: string; status: string };
  participants: CandidateInquiryParticipant[];
  latestMessage: {
    id: string;
    kind: 'USER' | 'SYSTEM';
    preview: string;
    createdAt: Date;
  } | null;
  lastActivityAt: Date | null;
  unreadCount: number;
};

const loadCandidateSummary = async (
  database: CandidateInquiryDatabase,
  conversation: NonNullable<Awaited<ReturnType<typeof getCandidateInquiryMembership>>>,
): Promise<CandidateInquiry> => {
  const [latestRow] = await loadCandidateMessageRows(database, conversation.id, { limit: 1 });
  const latest = latestRow ? (await loadMessageDetails(database, [latestRow]))[0] : undefined;
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
    ));

  return {
    id: conversation.id,
    type: 'CONVERSATION_CANDIDATE_INQUIRY',
    state: 'INQUIRY_OPEN',
    quest: {
      id: conversation.questId,
      title: conversation.questTitle,
      status: conversation.questStatus,
    },
    participants: await loadCandidateParticipants(database, conversation.id),
    latestMessage: latest
      ? {
          id: latest.id,
          kind: latest.kind,
          preview: latest.text ?? '',
          createdAt: latest.createdAt,
        }
      : null,
    lastActivityAt: latest?.createdAt ?? null,
    unreadCount: Number(unread?.count ?? 0),
  };
};

const inquiryUnavailable = (): CandidateInquiryServiceError =>
  new CandidateInquiryServiceError('INQUIRY_NOT_AVAILABLE', 'Candidate Inquiry is not available');

export const openCandidateInquiry = async (
  userId: string,
  questId: string,
): Promise<CandidateInquiry> => db.transaction(async (transaction) => {
  const [current] = await transaction
    .select({
      id: quest.id,
      hirerId: quest.hirerId,
      title: quest.title,
      questStatus: quest.questStatus,
      hiddenAt: quest.hiddenAt,
    })
    .from(quest)
    .where(eq(quest.id, questId))
    .limit(1)
    .for('update');
  if (!current || current.hirerId === userId || current.questStatus !== 'QUEST_OPEN' || current.hiddenAt) {
    throw inquiryUnavailable();
  }

  const [member] = await transaction
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.id, userId))
    .limit(1);
  if (!member) throw inquiryUnavailable();

  const [activeAssignment] = await transaction
    .select({ id: questAssignment.id })
    .from(questAssignment)
    .where(and(
      eq(questAssignment.questId, questId),
      eq(questAssignment.workerId, userId),
      eq(questAssignment.assignmentStatus, 'ASSIGNMENT_ACTIVE'),
    ))
    .limit(1);
  if (activeAssignment) throw inquiryUnavailable();

  const [existing] = await transaction
    .select({
      id: chatConversation.id,
      state: chatConversation.state,
    })
    .from(chatConversation)
    .where(and(
      eq(chatConversation.questId, questId),
      eq(chatConversation.type, 'CONVERSATION_CANDIDATE_INQUIRY'),
      eq(chatConversation.candidateWorkerId, userId),
    ))
    .limit(1)
    .for('update');
  if (existing?.state === 'INQUIRY_CLOSED') {
    throw new CandidateInquiryServiceError('INQUIRY_CLOSED', 'Candidate Inquiry is closed');
  }

  const conversationId = existing?.id ?? crypto.randomUUID();
  if (!existing) {
    await transaction.insert(chatConversation).values({
      id: conversationId,
      questId: current.id,
      type: 'CONVERSATION_CANDIDATE_INQUIRY',
      state: 'INQUIRY_OPEN',
      candidateWorkerId: userId,
      questTitle: current.title,
      questStatus: current.questStatus,
    });
    const now = new Date();
    await transaction.insert(chatMembership).values([
      {
        conversationId,
        memberId: current.hirerId,
        role: 'HIRER',
        joinedAt: now,
        createdAt: now,
      },
      {
        conversationId,
        memberId: userId,
        role: 'PROSPECTIVE_WORKER',
        joinedAt: now,
        createdAt: now,
      },
    ]);
  }

  const membership = await getCandidateInquiryMembership(transaction, userId, conversationId);
  if (!membership) throw new Error('Candidate Inquiry membership could not be created');
  return loadCandidateSummary(transaction, membership);
});

export const getCandidateInquiry = async (
  userId: string,
  conversationId: string,
): Promise<CandidateInquiry> => {
  const membership = await getCandidateInquiryMembership(db, userId, conversationId);
  if (!membership) throw new CandidateInquiryServiceError('CONVERSATION_NOT_FOUND', 'Conversation not found');
  return loadCandidateSummary(db, membership);
};

export const isCurrentCandidateInquiryMember = async (
  userId: string,
  conversationId: string,
): Promise<boolean> => Boolean(await getCandidateInquiryMembership(db, userId, conversationId));

export const listCandidateInquiries = async (
  userId: string,
  options: { limit: number; cursor?: CursorPayload },
) => {
  const lastActivityAt = sql`coalesce(max(${chatMessage.createdAt}), timestamp 'epoch')`;
  const cursor = options.cursor;
  const candidates = await db
    .select({ conversationId: chatMembership.conversationId })
    .from(chatMembership)
    .innerJoin(chatConversation, eq(chatConversation.id, chatMembership.conversationId))
    .leftJoin(chatMessage, and(
      eq(chatMessage.conversationId, chatConversation.id),
      isNull(chatMessage.deletedAt),
    ))
    .where(and(
      eq(chatMembership.memberId, userId),
      isNull(chatMembership.leftAt),
      eq(chatConversation.type, 'CONVERSATION_CANDIDATE_INQUIRY'),
      eq(chatConversation.state, 'INQUIRY_OPEN'),
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

  const pageIds = candidates.slice(0, options.limit);
  const conversations = await Promise.all(pageIds.map(async ({ conversationId }) => {
    const membership = await getCandidateInquiryMembership(db, userId, conversationId);
    return membership ? loadCandidateSummary(db, membership) : null;
  }));
  const page = conversations
    .filter((conversation): conversation is CandidateInquiry => conversation !== null)
    .sort((left, right) => {
      const leftTime = left.lastActivityAt?.getTime() ?? 0;
      const rightTime = right.lastActivityAt?.getTime() ?? 0;
      if (rightTime !== leftTime) return rightTime - leftTime;
      return right.id > left.id ? 1 : right.id < left.id ? -1 : 0;
    });
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: candidates.length > page.length && last
      ? { startTime: (last.lastActivityAt ?? new Date(0)).toISOString(), id: last.id }
      : null,
  };
};

export const listCandidateInquiryParticipants = async (
  userId: string,
  conversationId: string,
): Promise<CandidateInquiryParticipant[]> => {
  const membership = await getCandidateInquiryMembership(db, userId, conversationId);
  if (!membership) throw new CandidateInquiryServiceError('CONVERSATION_NOT_FOUND', 'Conversation not found');
  return loadCandidateParticipants(db, conversationId);
};

export const listCandidateInquiryMessages = async (
  userId: string,
  conversationId: string,
  options: { limit: number; before?: string; after?: string },
) => {
  const membership = await getCandidateInquiryMembership(db, userId, conversationId);
  if (!membership) throw new CandidateInquiryServiceError('CONVERSATION_NOT_FOUND', 'Conversation not found');
  const before = options.before ? decodeMessageCursor(options.before) : undefined;
  const after = options.after ? decodeMessageCursor(options.after) : undefined;
  if (before) await validateMessageCursor(db, conversationId, before);
  if (after) await validateMessageCursor(db, conversationId, after);

  const rows = await loadCandidateMessageRows(db, conversationId, { limit: options.limit, before, after });
  const hasMore = rows.length > options.limit;
  const selectedRows = rows.slice(0, options.limit);
  if (!after) selectedRows.reverse();
  const items = await loadMessageDetails(db, selectedRows);
  const cursorMessage = after ? selectedRows[selectedRows.length - 1] : selectedRows[0];
  return {
    items,
    hasMore,
    nextCursor: hasMore && cursorMessage
      ? encodeMessageCursor({ id: cursorMessage.id, sequence: cursorMessage.sequence })
      : null,
  };
};

const enforceCandidateInquiryRateLimit = async (
  database: CandidateInquiryDatabase,
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
    throw new CandidateInquiryServiceError(
      'RATE_LIMITED',
      'Chat rate limit exceeded',
      Math.max(...retryTimes),
    );
  }
};

const attachmentIdsForMessage = async (
  database: CandidateInquiryDatabase,
  messageId: string,
) => (await database
  .select({ id: chatMessageAttachment.attachmentId })
  .from(chatMessageAttachment)
  .where(eq(chatMessageAttachment.messageId, messageId))
  .orderBy(asc(chatMessageAttachment.position))).map(({ id }) => id);

export const sendCandidateInquiryMessage = async (
  userId: string,
  conversationId: string,
  input: { clientMessageId: string; text?: string; attachmentIds?: string[] },
) => {
  const result = await db.transaction(async (transaction) => {
    const [lockedConversation] = await transaction
      .select({
        id: chatConversation.id,
        questId: chatConversation.questId,
        nextSequence: chatConversation.nextSequence,
        state: chatConversation.state,
      })
      .from(chatConversation)
      .where(and(
        eq(chatConversation.id, conversationId),
        eq(chatConversation.type, 'CONVERSATION_CANDIDATE_INQUIRY'),
        isNull(chatConversation.deletedAt),
      ))
      .limit(1)
      .for('update');
    if (!lockedConversation || lockedConversation.state !== 'INQUIRY_OPEN') {
      throw new CandidateInquiryServiceError('CONVERSATION_NOT_FOUND', 'Conversation not found');
    }
    const membership = await getCandidateInquiryMembership(transaction, userId, conversationId);
    if (!membership) throw new CandidateInquiryServiceError('CONVERSATION_NOT_FOUND', 'Conversation not found');

    const text = input.text?.trim();
    const attachmentIds = input.attachmentIds ?? [];
    if (!text && attachmentIds.length === 0) {
      throw new CandidateInquiryServiceError('MESSAGE_CONTENT_REQUIRED', 'Message text or an Attachment is required');
    }
    if (text && text.length > 1000) {
      throw new CandidateInquiryServiceError('MESSAGE_TOO_LONG', 'Message text must be 1,000 characters or fewer');
    }
    if (attachmentIds.length > maxAttachmentsPerMessage) {
      throw new CandidateInquiryServiceError('ATTACHMENTS_TOO_MANY', 'A Message can contain at most 5 Attachments');
    }
    if (new Set(attachmentIds).size !== attachmentIds.length) {
      throw new CandidateInquiryServiceError('ATTACHMENTS_TOO_MANY', 'Attachment identifiers must be unique');
    }

    const [existing] = await transaction
      .select(messageFields)
      .from(chatMessage)
      .where(and(
        eq(chatMessage.conversationId, conversationId),
        eq(chatMessage.kind, 'USER'),
        eq(chatMessage.clientMessageId, input.clientMessageId),
        eq(chatMessage.senderMembershipId, membership.membershipId),
      ))
      .limit(1)
      .for('update');
    if (existing) {
      const existingAttachmentIds = await attachmentIdsForMessage(transaction, existing.id);
      if (existing.contentText !== (text ?? null) || existingAttachmentIds.join(',') !== attachmentIds.join(',')) {
        throw new CandidateInquiryServiceError('CLIENT_MESSAGE_ID_REUSED', 'The client Message identifier was used for different content');
      }
      return { message: (await loadMessageDetails(transaction, [existing]))[0]!, created: false };
    }

    await enforceCandidateInquiryRateLimit(transaction, userId, lockedConversation.questId, attachmentIds.length);

    const attachments = attachmentIds.length === 0
      ? []
      : await transaction
        .select({ id: chatAttachment.id })
        .from(chatAttachment)
        .where(and(
          inArray(chatAttachment.id, attachmentIds),
          eq(chatAttachment.conversationId, conversationId),
          eq(chatAttachment.uploadedByMemberId, membership.membershipId),
          eq(chatAttachment.status, 'VALIDATED'),
          isNull(chatAttachment.deletedAt),
        ))
        .for('update');
    if (attachments.length !== attachmentIds.length) {
      throw new CandidateInquiryServiceError('ATTACHMENT_NOT_FOUND', 'Attachment not found');
    }

    const createdAt = new Date();
    const [message] = await transaction
      .insert(chatMessage)
      .values({
        conversationId,
        sequence: lockedConversation.nextSequence,
        kind: 'USER',
        senderMembershipId: membership.membershipId,
        clientMessageId: input.clientMessageId,
        contentText: text ?? null,
        createdAt,
      })
      .returning(messageFields);
    if (!message) throw new Error('Candidate Inquiry Message could not be stored');

    if (attachments.length > 0) {
      const selectedById = new Map(attachments.map((attachment) => [attachment.id, attachment]));
      await transaction.insert(chatMessageAttachment).values(attachmentIds.map((attachmentId, index) => {
        if (!selectedById.has(attachmentId)) throw new CandidateInquiryServiceError('ATTACHMENT_NOT_FOUND', 'Attachment not found');
        return { messageId: message.id, attachmentId, position: index + 1 };
      }));
      await transaction
        .update(chatAttachment)
        .set({ status: 'CONSUMED', consumedAt: createdAt, expiresAt: null, updatedAt: createdAt })
        .where(inArray(chatAttachment.id, attachmentIds));
    }
    await transaction
      .update(chatConversation)
      .set({ nextSequence: sql`${chatConversation.nextSequence} + 1`, updatedAt: createdAt })
      .where(eq(chatConversation.id, conversationId));

    return { message: (await loadMessageDetails(transaction, [message]))[0]!, created: true };
  });

  if (result.created) {
    try {
      const recipients = await db
        .select({ memberId: chatMembership.memberId })
        .from(chatMembership)
        .innerJoin(chatConversation, eq(chatConversation.id, chatMembership.conversationId))
        .where(and(
          eq(chatMembership.conversationId, conversationId),
          isNull(chatMembership.leftAt),
          eq(chatConversation.state, 'INQUIRY_OPEN'),
        ));
      await workChatDelivery.publish({
        message: result.message,
        recipientMemberIds: recipients
          .map(({ memberId }) => memberId)
          .filter((memberId): memberId is string => memberId !== null && memberId !== userId),
      });
    } catch (error) {
      console.error('[candidate-inquiry-delivery] Post-commit publication failed', {
        conversationId,
        messageId: result.message.id,
        error,
      });
    }
  }
  return result.message;
};

type CandidateInquiryAttachment = {
  id: string;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  createdAt: Date;
};

const mapAttachmentStorageError = (error: unknown): CandidateInquiryServiceError => {
  if (error instanceof WorkChatAttachmentTooLargeError) {
    return new CandidateInquiryServiceError('ATTACHMENT_TOO_LARGE', error.message);
  }
  if (error instanceof UnsupportedWorkChatAttachmentError) {
    return new CandidateInquiryServiceError('ATTACHMENT_UNSUPPORTED', error.message);
  }
  return new CandidateInquiryServiceError('ATTACHMENT_UPLOAD_FAILED', 'Attachment upload failed');
};

export const uploadCandidateInquiryAttachment = async (
  userId: string,
  conversationId: string,
  upload: File,
): Promise<CandidateInquiryAttachment> => {
  const visibleConversation = await getCandidateInquiryMembership(db, userId, conversationId);
  if (!visibleConversation) throw new CandidateInquiryServiceError('CONVERSATION_NOT_FOUND', 'Conversation not found');

  let stored: Awaited<ReturnType<typeof workChatStorage.upload>>;
  try {
    stored = await workChatStorage.upload(userId, upload);
  } catch (error) {
    throw mapAttachmentStorageError(error);
  }

  try {
    return await db.transaction(async (transaction) => {
      const [lockedConversation] = await transaction
        .select({ id: chatConversation.id, state: chatConversation.state })
        .from(chatConversation)
        .where(and(
          eq(chatConversation.id, conversationId),
          eq(chatConversation.type, 'CONVERSATION_CANDIDATE_INQUIRY'),
          isNull(chatConversation.deletedAt),
        ))
        .limit(1)
        .for('update');
      if (!lockedConversation || lockedConversation.state !== 'INQUIRY_OPEN') {
        throw new CandidateInquiryServiceError('CONVERSATION_NOT_FOUND', 'Conversation not found');
      }
      const membership = await getCandidateInquiryMembership(transaction, userId, conversationId);
      if (!membership) throw new CandidateInquiryServiceError('CONVERSATION_NOT_FOUND', 'Conversation not found');

      const windowStart = new Date(Date.now() - rateLimitWindowMs);
      const recent = await transaction
        .select({ createdAt: chatAttachment.createdAt })
        .from(chatAttachment)
        .innerJoin(chatMembership, eq(chatMembership.id, chatAttachment.uploadedByMemberId!))
        .innerJoin(chatConversation, eq(chatConversation.id, chatAttachment.conversationId))
        .where(and(
          eq(chatConversation.questId, membership.questId),
          eq(chatMembership.memberId, userId),
          gte(chatAttachment.createdAt, windowStart),
          isNull(chatAttachment.deletedAt),
        ))
        .orderBy(asc(chatAttachment.createdAt));
      if (recent.length >= maxAttachmentsPerMinute && recent[0]) {
        throw new CandidateInquiryServiceError(
          'RATE_LIMITED',
          'Chat rate limit exceeded',
          retryAfterSeconds(recent[0].createdAt),
        );
      }

      const createdAt = new Date();
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
      if (!storedFile) throw new Error('Candidate Inquiry Attachment file could not be stored');

      const [attachment] = await transaction
        .insert(chatAttachment)
        .values({
          conversationId,
          uploadedByMemberId: membership.membershipId,
          fileId: storedFile.id,
          status: 'VALIDATED',
          originalFilename: stored.fileName,
          mimeType: stored.contentType,
          sizeBytes: stored.sizeBytes,
          expiresAt: new Date(createdAt.getTime() + preparedAttachmentLifetimeMs),
          validatedAt: createdAt,
          createdAt,
          updatedAt: createdAt,
        })
        .returning({
          id: chatAttachment.id,
          fileName: chatAttachment.originalFilename,
          mediaType: chatAttachment.mimeType,
          sizeBytes: chatAttachment.sizeBytes,
          createdAt: chatAttachment.createdAt,
        });
      if (!attachment) throw new Error('Candidate Inquiry Attachment could not be stored');
      return attachment;
    });
  } catch (error) {
    try {
      await workChatStorage.remove(stored);
    } catch (cleanupError) {
      console.error('[candidate-inquiry-attachment-upload] Compensating object deletion failed', {
        bucket: stored.bucket,
        objectKey: stored.objectKey,
        cleanupError,
      });
    }
    throw error;
  }
};

type CandidateInquiryAttachmentObject = { id: string; bucket: string; objectKey: string };

const deleteCandidateInquiryAttachmentObject = async (
  attachment: CandidateInquiryAttachmentObject,
): Promise<void> => {
  try {
    await workChatStorage.remove(attachment);
    await db.update(chatAttachment)
      .set({ objectDeletedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(chatAttachment.id, attachment.id),
        eq(chatAttachment.status, 'EXPIRED'),
        isNull(chatAttachment.objectDeletedAt),
      ));
  } catch (error) {
    console.error('[candidate-inquiry-attachment-cleanup] Object deletion failed', {
      attachmentId: attachment.id,
      bucket: attachment.bucket,
      objectKey: attachment.objectKey,
      error,
    });
  }
};

export const discardCandidateInquiryAttachment = async (
  userId: string,
  conversationId: string,
  attachmentId: string,
): Promise<{ attachmentId: string }> => {
  const attachment = await db.transaction(async (transaction) => {
    const membership = await getCandidateInquiryMembership(transaction, userId, conversationId);
    if (!membership) throw new CandidateInquiryServiceError('CONVERSATION_NOT_FOUND', 'Conversation not found');
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
        eq(chatAttachment.uploadedByMemberId, membership.membershipId),
        eq(chatAttachment.status, 'VALIDATED'),
        isNull(chatAttachment.deletedAt),
      ))
      .limit(1)
      .for('update');
    if (!storedAttachment) throw new CandidateInquiryServiceError('ATTACHMENT_NOT_FOUND', 'Attachment not found');
    const [consumed] = await transaction
      .select({ attachmentId: chatMessageAttachment.attachmentId })
      .from(chatMessageAttachment)
      .where(eq(chatMessageAttachment.attachmentId, attachmentId))
      .limit(1);
    if (consumed) throw new CandidateInquiryServiceError('ATTACHMENT_NOT_FOUND', 'Attachment not found');

    const deletedAt = new Date();
    await transaction.update(chatAttachment)
      .set({ status: 'EXPIRED', deletedAt, expiresAt: deletedAt, updatedAt: deletedAt })
      .where(eq(chatAttachment.id, attachmentId));
    await transaction.update(file).set({ deletedAt }).where(eq(file.id, storedAttachment.fileId!));
    return storedAttachment;
  });

  await deleteCandidateInquiryAttachmentObject(attachment);
  return { attachmentId: attachment.id };
};

export const getCandidateInquiryAttachmentLink = async (
  userId: string,
  conversationId: string,
  attachmentId: string,
) => {
  const membership = await getCandidateInquiryMembership(db, userId, conversationId);
  if (!membership) throw new CandidateInquiryServiceError('CONVERSATION_NOT_FOUND', 'Conversation not found');
  const [attachment] = await db
    .select({ id: chatAttachment.id, bucket: file.bucket, objectKey: file.objectKey })
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
    ))
    .limit(1);
  if (!attachment) throw new CandidateInquiryServiceError('ATTACHMENT_NOT_FOUND', 'Attachment not found');
  try {
    return { attachmentId: attachment.id, ...workChatStorage.linkFor(attachment) };
  } catch {
    throw new CandidateInquiryServiceError('ATTACHMENT_LINK_UNAVAILABLE', 'Attachment link is unavailable');
  }
};

export const advanceCandidateInquiryReadCursor = async (
  userId: string,
  conversationId: string,
  messageId: string,
) => db.transaction(async (transaction) => {
  const membership = await getCandidateInquiryMembership(transaction, userId, conversationId);
  if (!membership) throw new CandidateInquiryServiceError('CONVERSATION_NOT_FOUND', 'Conversation not found');
  const [message] = await transaction
    .select({ id: chatMessage.id, sequence: chatMessage.sequence })
    .from(chatMessage)
    .where(and(
      eq(chatMessage.id, messageId),
      eq(chatMessage.conversationId, conversationId),
      isNull(chatMessage.deletedAt),
    ))
    .limit(1);
  if (!message) throw new CandidateInquiryServiceError('MESSAGE_NOT_FOUND', 'Message not found');

  await transaction.insert(chatReadCursor)
    .values({ conversationId, membershipId: membership.membershipId, lastReadSequence: message.sequence })
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
      eq(chatReadCursor.membershipId, membership.membershipId),
    ))
    .limit(1);
  const [storedMessage] = await transaction
    .select({ id: chatMessage.id })
    .from(chatMessage)
    .where(and(
      eq(chatMessage.conversationId, conversationId),
      eq(chatMessage.sequence, storedCursor?.lastReadSequence ?? message.sequence),
      isNull(chatMessage.deletedAt),
    ))
    .limit(1);
  if (!storedMessage) throw new CandidateInquiryServiceError('MESSAGE_NOT_FOUND', 'Message not found');
  return { conversationId, messageId: storedMessage.id };
});
