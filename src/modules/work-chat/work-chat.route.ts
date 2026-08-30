import { authGuard } from '@/modules/auth';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { API_V1_PREFIX } from '@/shared/api-version';
import { rejectUnknownFields } from '@/shared/reject-unknown-fields';

import { Elysia } from 'elysia';

import {
  advanceWorkConversationReadCursorController,
  listWorkConversationMessagesController,
  listWorkConversationParticipantsController,
  listWorkConversationsController,
  sendWorkConversationMessageController,
} from './work-chat.controller';
import {
  workChatConversationListQuerySchema,
  workChatConversationListResponseSchema,
  workChatConversationParamsSchema,
  workChatMessageListQuerySchema,
  workChatMessageListResponseSchema,
  workChatMessageResponseSchema,
  workChatParticipantListResponseSchema,
  workChatReadCursorResponseSchema,
  workChatReadCursorSchema,
  workChatSendMessageSchema,
} from './work-chat.schema';

export const workChatRoute = new Elysia({
  name: 'work-chat-route',
  prefix: `${API_V1_PREFIX}/chat`,
})
  .use(authGuard)
  .get('/conversations', listWorkConversationsController, {
    query: workChatConversationListQuerySchema,
    response: responses(workChatConversationListResponseSchema, 400, 401),
    detail: {
      tags: ['Work Chat'],
      summary: 'List Work Conversations',
      description: 'Lists Work Conversations visible to the authenticated Member.',
      operationId: 'listWorkConversations',
      security: betterAuthSecurity,
    },
  })
  .get('/conversations/:conversationId/participants', listWorkConversationParticipantsController, {
    params: workChatConversationParamsSchema,
    response: responses(workChatParticipantListResponseSchema, 401, 404),
    detail: {
      tags: ['Work Chat'],
      summary: 'List Work Conversation Participants',
      description: 'Lists the current Hirer and Worker participants with their roles.',
      operationId: 'listWorkConversationParticipants',
      security: betterAuthSecurity,
    },
  })
  .get('/conversations/:conversationId/messages', listWorkConversationMessagesController, {
    params: workChatConversationParamsSchema,
    query: workChatMessageListQuerySchema,
    response: responses(workChatMessageListResponseSchema, 400, 401, 404),
    detail: {
      tags: ['Work Chat'],
      summary: 'List Work Conversation Messages',
      description: 'Returns visible Work Conversation history in sequence order.',
      operationId: 'listWorkConversationMessages',
      security: betterAuthSecurity,
    },
  })
  .post('/conversations/:conversationId/messages', sendWorkConversationMessageController, {
    params: workChatConversationParamsSchema,
    body: workChatSendMessageSchema,
    transform: rejectUnknownFields(workChatSendMessageSchema),
    response: responses(workChatMessageResponseSchema, 400, 401, 404, 409, 429),
    detail: {
      tags: ['Work Chat'],
      summary: 'Send a Work Conversation Message',
      description: 'Creates one immutable Message for a current Accepted Participant. The clientMessageId makes retries idempotent.',
      operationId: 'sendWorkConversationMessage',
      security: betterAuthSecurity,
    },
  })
  .post('/conversations/:conversationId/read', advanceWorkConversationReadCursorController, {
    params: workChatConversationParamsSchema,
    body: workChatReadCursorSchema,
    transform: rejectUnknownFields(workChatReadCursorSchema),
    response: responses(workChatReadCursorResponseSchema, 400, 401, 404),
    detail: {
      tags: ['Work Chat'],
      summary: 'Advance a Work Conversation Read Cursor',
      description: 'Advances the authenticated Member private Read Cursor to a visible Message.',
      operationId: 'advanceWorkConversationReadCursor',
      security: betterAuthSecurity,
    },
  });
