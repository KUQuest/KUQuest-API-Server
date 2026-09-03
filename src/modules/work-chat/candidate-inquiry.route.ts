import { authGuard } from '@/modules/auth';
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
import { isCurrentCandidateInquiryMember } from './candidate-inquiry.service';

const webSocketUnsubscribers = new WeakMap<object, () => void>();

export const candidateInquiryRoute = new Elysia({
  name: 'candidate-inquiry-route',
  prefix: `${API_V1_PREFIX}/chat/candidate-inquiries`,
})
  .use(authGuard)
  .ws('/:conversationId/events', {
    params: candidateInquiryParamsSchema,
    async open(ws) {
      const memberId = ws.data.session.user.id;
      const allowed = await isCurrentCandidateInquiryMember(memberId, ws.data.params.conversationId);
      if (!allowed) {
        ws.close(4403, 'Conversation not found');
        return;
      }
      const unsubscribe = workChatDelivery.subscribe(
        memberId,
        async (event) => {
          ws.send(JSON.stringify({ type: 'CANDIDATE_INQUIRY_MESSAGE', message: event.message }));
        },
        ws.data.params.conversationId,
      );
      webSocketUnsubscribers.set(ws, unsubscribe);
    },
    message(ws) {
      ws.close(1008, 'Candidate Inquiry Events are read-only');
    },
    close(ws) {
      webSocketUnsubscribers.get(ws)?.();
      webSocketUnsubscribers.delete(ws);
    },
    detail: {
      tags: ['Candidate Inquiry'],
      summary: 'Subscribe to Candidate Inquiry Events',
      description: 'Subscribes a current Candidate Inquiry participant to committed Message Events. REST remains authoritative and this channel is read-only.',
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
      description: 'Opens or returns the authenticated Prospective Worker Candidate Inquiry with a Hirer for an open Quest.',
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
      description: 'Lists open Candidate Inquiry Conversations visible to the authenticated Member.',
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
      description: 'Returns an open Candidate Inquiry Conversation visible to the authenticated participant.',
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
      description: 'Lists the Hirer and Prospective Worker in an open Candidate Inquiry Conversation.',
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
      description: 'Uploads an image, PDF, or video up to 10 MB for the authenticated participant to attach to a Message.',
      operationId: 'uploadCandidateInquiryAttachment',
      security: betterAuthSecurity,
    },
  })
  .get('/:conversationId/attachments/:attachmentId/link', getCandidateInquiryAttachmentLinkController, {
    params: candidateInquiryAttachmentParamsSchema,
    response: responses(candidateInquiryAttachmentLinkResponseSchema, 401, 404, 502),
    detail: {
      tags: ['Candidate Inquiry'],
      summary: 'Get a Candidate Inquiry Attachment Link',
      description: 'Returns a short-lived link for an attachment in a visible Candidate Inquiry Message.',
      operationId: 'getCandidateInquiryAttachmentLink',
      security: betterAuthSecurity,
    },
  })
  .delete('/:conversationId/attachments/:attachmentId', discardCandidateInquiryAttachmentController, {
    params: candidateInquiryAttachmentParamsSchema,
    response: responses(candidateInquiryAttachmentDiscardResponseSchema, 401, 404, 409),
    detail: {
      tags: ['Candidate Inquiry'],
      summary: 'Discard a Candidate Inquiry Attachment',
      description: 'Discards the authenticated participant attachment while it remains in the composer.',
      operationId: 'discardCandidateInquiryAttachment',
      security: betterAuthSecurity,
    },
  })
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
      description: 'Creates one immutable Message for a current Candidate Inquiry participant. The clientMessageId makes retries idempotent.',
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
      description: 'Advances the authenticated participant private Read Cursor to a visible Message.',
      operationId: 'advanceCandidateInquiryReadCursor',
      security: betterAuthSecurity,
    },
  });
