import { t } from 'elysia';

const candidateInquiryParticipantSchema = t.Object({
  id: t.Nullable(t.String({ format: 'uuid' })),
  role: t.Union([t.Literal('HIRER'), t.Literal('PROSPECTIVE_WORKER')]),
  displayName: t.String(),
});

const candidateInquiryAttachmentSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  fileName: t.String(),
  mediaType: t.String(),
  sizeBytes: t.Integer({ minimum: 1 }),
  createdAt: t.String({ format: 'date-time' }),
});

const candidateInquiryMessageSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  conversationId: t.String({ format: 'uuid' }),
  sequence: t.Integer({ minimum: 1 }),
  kind: t.Literal('USER'),
  sender: t.Object({
    id: t.Nullable(t.String({ format: 'uuid' })),
    displayName: t.String(),
  }),
  text: t.Nullable(t.String()),
  attachments: t.Array(candidateInquiryAttachmentSchema),
  systemType: t.Null(),
  systemPayload: t.Null(),
  eventId: t.Null(),
  createdAt: t.String({ format: 'date-time' }),
});

const candidateInquirySummarySchema = t.Object({
  id: t.String({ format: 'uuid' }),
  type: t.Literal('CONVERSATION_CANDIDATE_INQUIRY'),
  state: t.Literal('INQUIRY_OPEN'),
  quest: t.Object({
    id: t.String({ format: 'uuid' }),
    title: t.String(),
    status: t.String(),
  }),
  participants: t.Array(candidateInquiryParticipantSchema),
  latestMessage: t.Nullable(t.Object({
    id: t.String({ format: 'uuid' }),
    kind: t.Literal('USER'),
    preview: t.String(),
    createdAt: t.String({ format: 'date-time' }),
  })),
  lastActivityAt: t.Nullable(t.String({ format: 'date-time' })),
  unreadCount: t.Integer({ minimum: 0 }),
});

const candidateInquiryLinkSchema = t.Object({
  attachmentId: t.String({ format: 'uuid' }),
  url: t.String({ format: 'uri' }),
  expiresAt: t.String({ format: 'date-time' }),
});

export const candidateInquiryParamsSchema = t.Object({
  conversationId: t.String({ format: 'uuid' }),
});

export const candidateInquiryAttachmentParamsSchema = t.Object({
  conversationId: t.String({ format: 'uuid' }),
  attachmentId: t.String({ format: 'uuid' }),
});

export const candidateInquiryOpenSchema = t.Object(
  { questId: t.String({ format: 'uuid' }) },
  { additionalProperties: false },
);

export const candidateInquiryAttachmentUploadSchema = t.Object(
  { file: t.File() },
  { additionalProperties: false },
);

export const candidateInquiryListQuerySchema = t.Object(
  {
    limit: t.Optional(t.Integer({ minimum: 1, maximum: 20 })),
    cursor: t.Optional(t.String()),
  },
  { additionalProperties: false },
);

export const candidateInquiryMessageListQuerySchema = t.Object(
  {
    limit: t.Optional(t.Integer({ minimum: 1, maximum: 50 })),
    before: t.Optional(t.String()),
    after: t.Optional(t.String()),
  },
  { additionalProperties: false },
);

export const candidateInquirySendMessageSchema = t.Object(
  {
    clientMessageId: t.String({ minLength: 1, maxLength: 128, pattern: '\\S' }),
    text: t.Optional(t.String({ minLength: 1, maxLength: 1000, pattern: '\\S' })),
    attachmentIds: t.Optional(t.Array(t.String({ format: 'uuid' }), { maxItems: 5, uniqueItems: true })),
  },
  { additionalProperties: false },
);

export const candidateInquiryReadCursorSchema = t.Object(
  { messageId: t.String({ format: 'uuid' }) },
  { additionalProperties: false },
);

export const candidateInquiryResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({ inquiry: candidateInquirySummarySchema }),
});

export const candidateInquiryListResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    items: t.Array(candidateInquirySummarySchema),
    nextCursor: t.Nullable(t.String()),
  }),
});

export const candidateInquiryParticipantsResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({ participants: t.Array(candidateInquiryParticipantSchema) }),
});

export const candidateInquiryMessageListResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    items: t.Array(candidateInquiryMessageSchema),
    nextCursor: t.Nullable(t.String()),
    hasMore: t.Boolean(),
  }),
});

export const candidateInquiryMessageResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({ message: candidateInquiryMessageSchema }),
});

export const candidateInquiryAttachmentResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({ attachment: candidateInquiryAttachmentSchema }),
});

export const candidateInquiryAttachmentLinkResponseSchema = t.Object({
  success: t.Literal(true),
  data: candidateInquiryLinkSchema,
});

export const candidateInquiryAttachmentDiscardResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({ attachmentId: t.String({ format: 'uuid' }) }),
});

export const candidateInquiryReadCursorResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    conversationId: t.String({ format: 'uuid' }),
    messageId: t.String({ format: 'uuid' }),
  }),
});

export type CandidateInquiryOpenInput = typeof candidateInquiryOpenSchema.static;
export type CandidateInquiryListQuery = typeof candidateInquiryListQuerySchema.static;
export type CandidateInquiryMessageListQuery = typeof candidateInquiryMessageListQuerySchema.static;
export type CandidateInquiryParams = typeof candidateInquiryParamsSchema.static;
export type CandidateInquiryAttachmentParams = typeof candidateInquiryAttachmentParamsSchema.static;
export type CandidateInquiryAttachmentUploadInput = typeof candidateInquiryAttachmentUploadSchema.static;
export type CandidateInquirySendMessageInput = typeof candidateInquirySendMessageSchema.static;
export type CandidateInquiryReadCursorInput = typeof candidateInquiryReadCursorSchema.static;
