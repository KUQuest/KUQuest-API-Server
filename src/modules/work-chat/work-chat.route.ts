import { authGuard } from '@/modules/auth';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { API_V1_PREFIX } from '@/shared/api-version';
import { rejectUnknownFields } from '@/shared/reject-unknown-fields';

import { Elysia } from 'elysia';

import {
  advanceWorkConversationReadCursorController,
  discardWorkConversationAttachmentController,
  getWorkConversationAttachmentLinkController,
  listWorkConversationMessagesController,
  listWorkConversationParticipantsController,
  listWorkConversationsController,
  sendWorkConversationMessageController,
  uploadWorkConversationAttachmentController,
} from './work-chat.controller';
import {
  workChatAttachmentLinkResponseSchema,
  workChatAttachmentDiscardResponseSchema,
  workChatAttachmentParamsSchema,
  workChatAttachmentResponseSchema,
  workChatAttachmentUploadSchema,
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
import { workChatDelivery } from './work-chat.delivery';
import { isCurrentWorkConversationMember } from './work-chat.service';

const webSocketUnsubscribers = new WeakMap<object, () => void>();

export const workChatRoute = new Elysia({
  name: 'work-chat-route',
  prefix: `${API_V1_PREFIX}/chat`,
})
  .use(authGuard)
  .ws('/conversations/:conversationId/events', {
    params: workChatConversationParamsSchema,
    async open(ws) {
      const memberId = ws.data.session.user.id;
      const allowed = await isCurrentWorkConversationMember(memberId, ws.data.params.conversationId);
      if (!allowed) {
        ws.close(4403, 'Conversation not found');
        return;
      }
      const unsubscribe = workChatDelivery.subscribe(
        memberId,
        async (event) => {
          ws.send(JSON.stringify({ type: 'WORK_CONVERSATION_MESSAGE', message: event.message }));
        },
        ws.data.params.conversationId,
      );
      webSocketUnsubscribers.set(ws, unsubscribe);
    },
    message(ws) {
      ws.close(1008, 'Work Conversation Events are read-only');
    },
    close(ws) {
      webSocketUnsubscribers.get(ws)?.();
      webSocketUnsubscribers.delete(ws);
    },
    detail: {
      tags: ['Work Chat'],
      summary: 'Subscribe to committed Work Conversation Events',
      description: 'Subscribes a current Work Conversation Member to committed Message Events. REST remains authoritative and this channel is read-only.',
      operationId: 'subscribeWorkConversationEvents',
      security: betterAuthSecurity,
    },
  })
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
  .post('/conversations/:conversationId/attachments', uploadWorkConversationAttachmentController, {
    params: workChatConversationParamsSchema,
    body: workChatAttachmentUploadSchema,
    type: 'multipart/form-data',
    response: responses(workChatAttachmentResponseSchema, 401, 404, 409, 413, 415, 429, 502),
    detail: {
      tags: ['Work Chat'],
      summary: 'Upload a Work Conversation Attachment',
      description: 'Uploads an image, PDF, or video up to 10 MB for the authenticated current Member to attach to a Message.',
      operationId: 'uploadWorkConversationAttachment',
      security: betterAuthSecurity,
    },
  })
  .get('/conversations/:conversationId/attachments/:attachmentId/link', getWorkConversationAttachmentLinkController, {
    params: workChatAttachmentParamsSchema,
    response: responses(workChatAttachmentLinkResponseSchema, 401, 404, 502),
    detail: {
      tags: ['Work Chat'],
      summary: 'Get a Work Conversation Attachment Link',
      description: 'Returns a short-lived link for an attachment in a visible Work Conversation Message.',
      operationId: 'getWorkConversationAttachmentLink',
      security: betterAuthSecurity,
    },
  })
  .delete('/conversations/:conversationId/attachments/:attachmentId', discardWorkConversationAttachmentController, {
    params: workChatAttachmentParamsSchema,
    response: responses(workChatAttachmentDiscardResponseSchema, 401, 404, 409),
    detail: {
      tags: ['Work Chat'],
      summary: 'Discard a Work Conversation Attachment',
      description: 'Discards the authenticated current Member attachment while it remains in the composer.',
      operationId: 'discardWorkConversationAttachment',
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
