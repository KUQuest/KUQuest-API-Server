import type { AuthedContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';
import { CursorInputError, decodeCursor, encodeCursor } from '@/shared/cursor';

import type { Static } from 'elysia';

import {
  advanceWorkConversationReadCursor,
  listWorkConversationMessages,
  listWorkConversationParticipants,
  listWorkConversations,
  sendWorkConversationMessage,
  WorkChatServiceError,
} from './work-chat.service';
import type {
  workChatConversationListQuerySchema,
  workChatConversationParamsSchema,
  workChatMessageListQuerySchema,
  workChatReadCursorSchema,
  workChatSendMessageSchema,
} from './work-chat.schema';

type ConversationListQuery = Static<typeof workChatConversationListQuerySchema>;
type MessageListQuery = Static<typeof workChatMessageListQuerySchema>;
type ConversationParams = Static<typeof workChatConversationParamsSchema>;
type SendMessageInput = Static<typeof workChatSendMessageSchema>;
type ReadCursorInput = Static<typeof workChatReadCursorSchema>;

const serializeMessage = (message: Awaited<ReturnType<typeof sendWorkConversationMessage>>) => ({
  ...message,
  createdAt: message.createdAt.toISOString(),
  attachments: message.attachments.map((attachment) => ({
    ...attachment,
    createdAt: attachment.createdAt.toISOString(),
  })),
});

const serializeConversation = (conversation: Awaited<ReturnType<typeof listWorkConversations>>['items'][number]) => ({
  ...conversation,
  latestMessage: conversation.latestMessage
    ? { ...conversation.latestMessage, createdAt: conversation.latestMessage.createdAt.toISOString() }
    : null,
  lastActivityAt: conversation.lastActivityAt?.toISOString() ?? null,
});

const mapWorkChatError = (set: AuthedContext['set'], error: unknown) => {
  if (error instanceof CursorInputError) {
    set.status = 400;
    return apiError(error.code, error.message);
  }
  if (!(error instanceof WorkChatServiceError)) throw error;
  if (error.code === 'CONVERSATION_NOT_FOUND' || error.code === 'MESSAGE_NOT_FOUND' || error.code === 'ATTACHMENT_NOT_FOUND') {
    set.status = 404;
  } else if (error.code === 'MESSAGE_CONTENT_REQUIRED') {
    set.status = 400;
  } else if (error.code === 'RATE_LIMITED') {
    set.status = 429;
  } else {
    set.status = 409;
  }
  return apiError(error.code, error.message);
};

export const listWorkConversationsController = async ({
  query,
  session,
  set,
}: AuthedContext & { query: ConversationListQuery }): Promise<ApiResponse> => {
  try {
    const result = await listWorkConversations(session.user.id, {
      limit: query.limit ?? 20,
      cursor: decodeCursor(query.cursor),
    });
    return apiSuccess({
      items: result.items.map(serializeConversation),
      nextCursor: result.nextCursor ? encodeCursor(result.nextCursor) : null,
    });
  } catch (error) {
    return mapWorkChatError(set, error);
  }
};

export const listWorkConversationMessagesController = async ({
  params,
  query,
  session,
  set,
}: AuthedContext & { params: ConversationParams; query: MessageListQuery }): Promise<ApiResponse> => {
  if (query.before !== undefined && query.after !== undefined) {
    set.status = 400;
    return apiError('VALIDATION', 'before and after cannot be used together');
  }
  try {
    const result = await listWorkConversationMessages(session.user.id, params.conversationId, {
      limit: query.limit ?? 50,
      before: query.before,
      after: query.after,
    });
    return apiSuccess({
      items: result.items.map(serializeMessage),
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    });
  } catch (error) {
    return mapWorkChatError(set, error);
  }
};

export const listWorkConversationParticipantsController = async ({
  params,
  session,
  set,
}: AuthedContext & { params: ConversationParams }): Promise<ApiResponse> => {
  try {
    return apiSuccess({ participants: await listWorkConversationParticipants(session.user.id, params.conversationId) });
  } catch (error) {
    return mapWorkChatError(set, error);
  }
};

export const sendWorkConversationMessageController = async ({
  body,
  params,
  session,
  set,
}: AuthedContext & { body: SendMessageInput; params: ConversationParams }): Promise<ApiResponse> => {
  try {
    const message = await sendWorkConversationMessage(session.user.id, params.conversationId, body);
    return apiSuccess({ message: serializeMessage(message) });
  } catch (error) {
    return mapWorkChatError(set, error);
  }
};

export const advanceWorkConversationReadCursorController = async ({
  body,
  params,
  session,
  set,
}: AuthedContext & { body: ReadCursorInput; params: ConversationParams }): Promise<ApiResponse> => {
  try {
    return apiSuccess(await advanceWorkConversationReadCursor(session.user.id, params.conversationId, body.messageId));
  } catch (error) {
    return mapWorkChatError(set, error);
  }
};
