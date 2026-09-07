import type { AuthedContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';
import { CursorInputError, decodeCursor, encodeCursor } from '@/shared/cursor';

import type { Static } from 'elysia';

import {
  advanceCandidateInquiryReadCursor,
  discardCandidateInquiryAttachment,
  getCandidateInquiry,
  getCandidateInquiryAttachmentLink,
  listCandidateInquiryMessages,
  listCandidateInquiryParticipants,
  listCandidateInquiries,
  openCandidateInquiry,
  sendCandidateInquiryMessage,
  uploadCandidateInquiryAttachment,
  CandidateInquiryServiceError,
} from './candidate-inquiry.service';
import type {
  candidateInquiryAttachmentParamsSchema,
  candidateInquiryAttachmentUploadSchema,
  candidateInquiryListQuerySchema,
  candidateInquiryMessageListQuerySchema,
  candidateInquiryOpenSchema,
  candidateInquiryParamsSchema,
  candidateInquiryReadCursorSchema,
  candidateInquirySendMessageSchema,
} from './candidate-inquiry.schema';

type OpenInput = Static<typeof candidateInquiryOpenSchema>;
type ListQuery = Static<typeof candidateInquiryListQuerySchema>;
type MessageListQuery = Static<typeof candidateInquiryMessageListQuerySchema>;
type InquiryParams = Static<typeof candidateInquiryParamsSchema>;
type AttachmentParams = Static<typeof candidateInquiryAttachmentParamsSchema>;
type AttachmentUploadInput = Static<typeof candidateInquiryAttachmentUploadSchema>;
type SendMessageInput = Static<typeof candidateInquirySendMessageSchema>;
type ReadCursorInput = Static<typeof candidateInquiryReadCursorSchema>;

const serializeMessage = (message: Awaited<ReturnType<typeof sendCandidateInquiryMessage>>) => ({
  ...message,
  createdAt: message.createdAt.toISOString(),
  attachments: message.attachments.map((attachment) => ({
    ...attachment,
    createdAt: attachment.createdAt.toISOString(),
  })),
});

const serializeAttachment = (attachment: Awaited<ReturnType<typeof uploadCandidateInquiryAttachment>>) => ({
  ...attachment,
  createdAt: attachment.createdAt.toISOString(),
});

const serializeInquiry = (inquiry: Awaited<ReturnType<typeof getCandidateInquiry>>) => ({
  ...inquiry,
  latestMessage: inquiry.latestMessage
    ? { ...inquiry.latestMessage, createdAt: inquiry.latestMessage.createdAt.toISOString() }
    : null,
  lastActivityAt: inquiry.lastActivityAt?.toISOString() ?? null,
});

const mapCandidateInquiryError = (set: AuthedContext['set'], error: unknown) => {
  if (error instanceof CursorInputError) {
    set.status = 400;
    return apiError(error.code, error.message);
  }
  if (!(error instanceof CandidateInquiryServiceError)) throw error;
  if (
    error.code === 'CONVERSATION_NOT_FOUND' ||
    error.code === 'INQUIRY_NOT_AVAILABLE' ||
    error.code === 'MESSAGE_NOT_FOUND' ||
    error.code === 'ATTACHMENT_NOT_FOUND'
  ) {
    set.status = 404;
  } else if (error.code === 'ATTACHMENT_TOO_LARGE') {
    set.status = 413;
  } else if (error.code === 'ATTACHMENT_UNSUPPORTED') {
    set.status = 415;
  } else if (error.code === 'ATTACHMENT_UPLOAD_FAILED' || error.code === 'ATTACHMENT_LINK_UNAVAILABLE') {
    set.status = 502;
  } else if (
    error.code === 'MESSAGE_CONTENT_REQUIRED' ||
    error.code === 'MESSAGE_TOO_LONG' ||
    error.code === 'ATTACHMENT_IDS_DUPLICATE'
  ) {
    set.status = 400;
  } else if (error.code === 'RATE_LIMITED') {
    set.status = 429;
    if (error.retryAfterSeconds !== undefined) {
      (set as unknown as { headers: Record<string, string> }).headers['Retry-After'] = String(error.retryAfterSeconds);
    }
  } else {
    set.status = 409;
  }
  return apiError(error.code, error.message);
};

export const openCandidateInquiryController = async ({
  body,
  session,
  set,
}: AuthedContext & { body: OpenInput }): Promise<ApiResponse> => {
  try {
    return apiSuccess({ inquiry: serializeInquiry(await openCandidateInquiry(session.user.id, body.questId)) });
  } catch (error) {
    return mapCandidateInquiryError(set, error);
  }
};

export const listCandidateInquiriesController = async ({
  query,
  session,
  set,
}: AuthedContext & { query: ListQuery }): Promise<ApiResponse> => {
  try {
    const result = await listCandidateInquiries(session.user.id, {
      limit: query.limit ?? 20,
      cursor: decodeCursor(query.cursor),
    });
    return apiSuccess({
      items: result.items.map(serializeInquiry),
      nextCursor: result.nextCursor ? encodeCursor(result.nextCursor) : null,
    });
  } catch (error) {
    return mapCandidateInquiryError(set, error);
  }
};

export const getCandidateInquiryController = async ({
  params,
  session,
  set,
}: AuthedContext & { params: InquiryParams }): Promise<ApiResponse> => {
  try {
    return apiSuccess({ inquiry: serializeInquiry(await getCandidateInquiry(session.user.id, params.conversationId)) });
  } catch (error) {
    return mapCandidateInquiryError(set, error);
  }
};

export const listCandidateInquiryParticipantsController = async ({
  params,
  session,
  set,
}: AuthedContext & { params: InquiryParams }): Promise<ApiResponse> => {
  try {
    return apiSuccess({
      participants: await listCandidateInquiryParticipants(session.user.id, params.conversationId),
    });
  } catch (error) {
    return mapCandidateInquiryError(set, error);
  }
};

export const listCandidateInquiryMessagesController = async ({
  params,
  query,
  session,
  set,
}: AuthedContext & { params: InquiryParams; query: MessageListQuery }): Promise<ApiResponse> => {
  if (query.before !== undefined && query.after !== undefined) {
    set.status = 400;
    return apiError('VALIDATION', 'before and after cannot be used together');
  }
  try {
    const result = await listCandidateInquiryMessages(session.user.id, params.conversationId, {
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
    return mapCandidateInquiryError(set, error);
  }
};

export const sendCandidateInquiryMessageController = async ({
  body,
  params,
  session,
  set,
}: AuthedContext & { body: SendMessageInput; params: InquiryParams }): Promise<ApiResponse> => {
  try {
    const message = await sendCandidateInquiryMessage(session.user.id, params.conversationId, body);
    return apiSuccess({ message: serializeMessage(message) });
  } catch (error) {
    return mapCandidateInquiryError(set, error);
  }
};

export const advanceCandidateInquiryReadCursorController = async ({
  body,
  params,
  session,
  set,
}: AuthedContext & { body: ReadCursorInput; params: InquiryParams }): Promise<ApiResponse> => {
  try {
    return apiSuccess(await advanceCandidateInquiryReadCursor(
      session.user.id,
      params.conversationId,
      body.messageId,
    ));
  } catch (error) {
    return mapCandidateInquiryError(set, error);
  }
};

export const uploadCandidateInquiryAttachmentController = async ({
  body,
  params,
  session,
  set,
}: AuthedContext & { body: AttachmentUploadInput; params: InquiryParams }): Promise<ApiResponse> => {
  try {
    const attachment = await uploadCandidateInquiryAttachment(session.user.id, params.conversationId, body.file);
    return apiSuccess({ attachment: serializeAttachment(attachment) });
  } catch (error) {
    return mapCandidateInquiryError(set, error);
  }
};

export const getCandidateInquiryAttachmentLinkController = async ({
  params,
  session,
  set,
}: AuthedContext & { params: AttachmentParams }): Promise<ApiResponse> => {
  try {
    const link = await getCandidateInquiryAttachmentLink(
      session.user.id,
      params.conversationId,
      params.attachmentId,
    );
    return apiSuccess({ ...link, expiresAt: link.expiresAt.toISOString() });
  } catch (error) {
    return mapCandidateInquiryError(set, error);
  }
};

export const discardCandidateInquiryAttachmentController = async ({
  params,
  session,
  set,
}: AuthedContext & { params: AttachmentParams }): Promise<ApiResponse> => {
  try {
    return apiSuccess(await discardCandidateInquiryAttachment(
      session.user.id,
      params.conversationId,
      params.attachmentId,
    ));
  } catch (error) {
    return mapCandidateInquiryError(set, error);
  }
};
