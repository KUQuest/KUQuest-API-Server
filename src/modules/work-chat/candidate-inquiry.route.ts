import { authGuard, closeSocketForActiveMemberBan, memberBanGuard } from '@/modules/auth';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { API_V1_PREFIX } from '@/shared/api-version';
import { rejectUnknownFields } from '@/shared/reject-unknown-fields';

import { Elysia } from 'elysia';

import {
  advanceCandidateInquiryReadCursorController,
  discardCandidateInquiryAttachmentController,
  getCandidateInquiryAttachmentLinkController,
  getCandidateInquiryController,
  listCandidateInquiryMessagesController,
  listCandidateInquiryParticipantsController,
  listCandidateInquiriesController,
  openCandidateInquiryController,
  sendCandidateInquiryMessageController,
  uploadCandidateInquiryAttachmentController,
} from './candidate-inquiry.controller';
import {
  extractChatSocketClientMessageId,
  parseChatSocketSendMessage,
  serializeChatSocketMessage,
} from './chat-socket.schema';
import {
  CandidateInquiryServiceError,
  isCurrentCandidateInquiryMember,
  sendCandidateInquiryMessage,
} from './candidate-inquiry.service';
import {
  candidateInquiryAttachmentDiscardResponseSchema,
  candidateInquiryAttachmentLinkResponseSchema,
  candidateInquiryAttachmentParamsSchema,
  candidateInquiryAttachmentResponseSchema,
  candidateInquiryAttachmentUploadSchema,
  candidateInquiryListQuerySchema,
  candidateInquiryListResponseSchema,
  candidateInquiryMessageListQuerySchema,
  candidateInquiryMessageListResponseSchema,
  candidateInquiryMessageResponseSchema,
  candidateInquiryOpenSchema,
  candidateInquiryParamsSchema,
  candidateInquiryParticipantsResponseSchema,
  candidateInquiryReadCursorResponseSchema,
  candidateInquiryReadCursorSchema,
  candidateInquiryResponseSchema,
  candidateInquirySendMessageSchema,
} from './candidate-inquiry.schema';
import { workChatDelivery } from './work-chat.delivery';
const webSocketUnsubscribers = new WeakMap<object, () => void>();

const sendCandidateInquirySocketRejection = (
  ws: { send: (message: string) => unknown },
  clientMessageId: string | null,
  code: string,
  message: string
) => {
  ws.send(
    JSON.stringify({
      type: 'MESSAGE_REJECTED',
      clientMessageId,
      error: { code, message },
    })
  );
};

export const candidateInquiryRoute = new Elysia({
  name: 'candidate-inquiry-route',
  prefix: `${API_V1_PREFIX}/chat/candidate-inquiries`,
})
  .use(authGuard)
  .use(memberBanGuard)
  .ws('/:conversationId/events', {
    params: candidateInquiryParamsSchema,
    async open(ws) {
      const memberId = ws.data.session.user.id;
      const allowed = await isCurrentCandidateInquiryMember(
        memberId,
        ws.data.params.conversationId
      );
      if (!allowed) {
        ws.close(4403, 'Conversation not found');
        return;
      }
      const unsubscribe = workChatDelivery.subscribe(
        memberId,
        async (event) => {
          if (await closeSocketForActiveMemberBan(ws, memberId)) return;
          ws.send(JSON.stringify({ type: 'CANDIDATE_INQUIRY_MESSAGE', message: event.message }));
        },
        ws.data.params.conversationId
      );
      webSocketUnsubscribers.set(ws, unsubscribe);
    },
    async message(ws, payload) {
      const memberId = ws.data.session.user.id;
      if (await closeSocketForActiveMemberBan(ws, memberId)) return;

      const command = parseChatSocketSendMessage(payload);
      if (!command) {
        sendCandidateInquirySocketRejection(
          ws,
          extractChatSocketClientMessageId(payload),
          'INVALID_COMMAND',
          'Only a valid SEND_MESSAGE command is supported'
        );
        ws.close(1008, 'Invalid Candidate Inquiry command');
        return;
      }

      try {
        const message = await sendCandidateInquiryMessage(
          memberId,
          ws.data.params.conversationId,
          command
        );
        ws.send(
          JSON.stringify({
            type: 'MESSAGE_ACCEPTED',
            clientMessageId: command.clientMessageId,
            message: serializeChatSocketMessage(message),
          })
        );
      } catch (error) {
        if (!(error instanceof CandidateInquiryServiceError)) throw error;
        sendCandidateInquirySocketRejection(ws, command.clientMessageId, error.code, error.message);
      }
    },
    close(ws) {
      webSocketUnsubscribers.get(ws)?.();
      webSocketUnsubscribers.delete(ws);
    },
    detail: {
      tags: ['Candidate Inquiry'],
      summary: 'Subscribe to Candidate Inquiry Events and send Messages',
      description:
        'Subscribes a current Candidate Inquiry participant to committed Message Events and accepts optional SEND_MESSAGE commands. REST remains authoritative for persistence and recovery.',
      operationId: 'subscribeCandidateInquiryEvents',
      security: betterAuthSecurity,
    },
  })
  .post('', openCandidateInquiryController, {
    body: candidateInquiryOpenSchema,
    transform: rejectUnknownFields(candidateInquiryOpenSchema),
    response: responses(candidateInquiryResponseSchema, 400, 401, 404, 409),
    detail: {
      tags: ['Candidate Inquiry'],
      summary: 'Open a Candidate Inquiry Conversation',
      description:
        'Opens or returns the authenticated Prospective Worker Candidate Inquiry with a Hirer for an open Quest.',
      operationId: 'openCandidateInquiry',
      security: betterAuthSecurity,
    },
  })
  .get('', listCandidateInquiriesController, {
    query: candidateInquiryListQuerySchema,
    response: responses(candidateInquiryListResponseSchema, 400, 401),
    detail: {
      tags: ['Candidate Inquiry'],
      summary: 'List Candidate Inquiry Conversations',
      description:
        'Lists open Candidate Inquiry Conversations visible to the authenticated Member.',
      operationId: 'listCandidateInquiries',
      security: betterAuthSecurity,
    },
  })
  .get('/:conversationId', getCandidateInquiryController, {
    params: candidateInquiryParamsSchema,
    response: responses(candidateInquiryResponseSchema, 401, 404),
    detail: {
      tags: ['Candidate Inquiry'],
      summary: 'Get a Candidate Inquiry Conversation',
      description:
        'Returns an open Candidate Inquiry Conversation visible to the authenticated participant.',
      operationId: 'getCandidateInquiry',
      security: betterAuthSecurity,
    },
  })
  .get('/:conversationId/participants', listCandidateInquiryParticipantsController, {
    params: candidateInquiryParamsSchema,
    response: responses(candidateInquiryParticipantsResponseSchema, 401, 404),
    detail: {
      tags: ['Candidate Inquiry'],
      summary: 'List Candidate Inquiry Participants',
      description:
        'Lists the Hirer and Prospective Worker with their avatars when available in an open Candidate Inquiry Conversation.',
      operationId: 'listCandidateInquiryParticipants',
      security: betterAuthSecurity,
    },
  })
  .post('/:conversationId/attachments', uploadCandidateInquiryAttachmentController, {
    params: candidateInquiryParamsSchema,
    body: candidateInquiryAttachmentUploadSchema,
    type: 'multipart/form-data',
    response: responses(candidateInquiryAttachmentResponseSchema, 401, 404, 413, 415, 429, 502),
    detail: {
      tags: ['Candidate Inquiry'],
      summary: 'Upload a Candidate Inquiry Attachment',
      description:
        'Uploads an image, PDF, or video up to 10 MB for the authenticated participant to attach to a Message.',
      operationId: 'uploadCandidateInquiryAttachment',
      security: betterAuthSecurity,
    },
  })
  .get(
    '/:conversationId/attachments/:attachmentId/link',
    getCandidateInquiryAttachmentLinkController,
    {
      params: candidateInquiryAttachmentParamsSchema,
      response: responses(candidateInquiryAttachmentLinkResponseSchema, 401, 404, 502),
      detail: {
        tags: ['Candidate Inquiry'],
        summary: 'Get a Candidate Inquiry Attachment Link',
        description:
          'Returns a short-lived link for an attachment in a visible Candidate Inquiry Message.',
        operationId: 'getCandidateInquiryAttachmentLink',
        security: betterAuthSecurity,
      },
    }
  )
  .delete(
    '/:conversationId/attachments/:attachmentId',
    discardCandidateInquiryAttachmentController,
    {
      params: candidateInquiryAttachmentParamsSchema,
      response: responses(candidateInquiryAttachmentDiscardResponseSchema, 401, 404, 409),
      detail: {
        tags: ['Candidate Inquiry'],
        summary: 'Discard a Candidate Inquiry Attachment',
        description:
          'Discards the authenticated participant attachment while it remains in the composer.',
        operationId: 'discardCandidateInquiryAttachment',
        security: betterAuthSecurity,
      },
    }
  )
  .get('/:conversationId/messages', listCandidateInquiryMessagesController, {
    params: candidateInquiryParamsSchema,
    query: candidateInquiryMessageListQuerySchema,
    response: responses(candidateInquiryMessageListResponseSchema, 400, 401, 404),
    detail: {
      tags: ['Candidate Inquiry'],
      summary: 'List Candidate Inquiry Messages',
      description: 'Returns visible Candidate Inquiry Message history in sequence order.',
      operationId: 'listCandidateInquiryMessages',
      security: betterAuthSecurity,
    },
  })
  .post('/:conversationId/messages', sendCandidateInquiryMessageController, {
    params: candidateInquiryParamsSchema,
    body: candidateInquirySendMessageSchema,
    transform: rejectUnknownFields(candidateInquirySendMessageSchema),
    response: responses(candidateInquiryMessageResponseSchema, 400, 401, 404, 409, 429),
    detail: {
      tags: ['Candidate Inquiry'],
      summary: 'Send a Candidate Inquiry Message',
      description:
        'Creates one immutable Message for a current Candidate Inquiry participant. The clientMessageId makes retries idempotent.',
      operationId: 'sendCandidateInquiryMessage',
      security: betterAuthSecurity,
    },
  })
  .post('/:conversationId/read', advanceCandidateInquiryReadCursorController, {
    params: candidateInquiryParamsSchema,
    body: candidateInquiryReadCursorSchema,
    transform: rejectUnknownFields(candidateInquiryReadCursorSchema),
    response: responses(candidateInquiryReadCursorResponseSchema, 400, 401, 404),
    detail: {
      tags: ['Candidate Inquiry'],
      summary: 'Advance a Candidate Inquiry Read Cursor',
      description:
        'Advances the authenticated participant private Read Cursor to a visible Message.',
      operationId: 'advanceCandidateInquiryReadCursor',
      security: betterAuthSecurity,
    },
  });
