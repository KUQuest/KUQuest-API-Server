import { t } from 'elysia';

const conversationSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  type: t.Literal('CONVERSATION_WORK'),
  quest: t.Object({
    id: t.String({ format: 'uuid' }),
    title: t.String(),
    status: t.String(),
  }),
  latestMessage: t.Nullable(t.Object({
    id: t.String({ format: 'uuid' }),
    kind: t.Union([t.Literal('USER'), t.Literal('SYSTEM')]),
    preview: t.String(),
    createdAt: t.String({ format: 'date-time' }),
  })),
  lastActivityAt: t.Nullable(t.String({ format: 'date-time' })),
  archived: t.Boolean(),
  readOnly: t.Boolean(),
  unreadCount: t.Integer({ minimum: 0 }),
});

const attachmentSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  fileName: t.String(),
  mediaType: t.String(),
  sizeBytes: t.Integer({ minimum: 1 }),
  createdAt: t.String({ format: 'date-time' }),
});

const workChatAttachmentLinkSchema = t.Object({
  attachmentId: t.String({ format: 'uuid' }),
  url: t.String({ format: 'uri' }),
  expiresAt: t.String({ format: 'date-time' }),
});

const messageSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  conversationId: t.String({ format: 'uuid' }),
  sequence: t.Integer({ minimum: 1 }),
  kind: t.Union([t.Literal('USER'), t.Literal('SYSTEM')]),
  sender: t.Nullable(t.Object({
    id: t.Nullable(t.String({ format: 'uuid' })),
    displayName: t.String(),
  })),
  text: t.Nullable(t.String()),
  attachments: t.Array(attachmentSchema),
  systemType: t.Nullable(t.String()),
  systemPayload: t.Nullable(t.Record(t.String(), t.Unknown())),
  eventId: t.Nullable(t.String()),
  createdAt: t.String({ format: 'date-time' }),
});

const participantSchema = t.Object({
  id: t.Nullable(t.String({ format: 'uuid' })),
  role: t.Union([t.Literal('HIRER'), t.Literal('WORKER')]),
  displayName: t.String(),
});

export const workChatConversationParamsSchema = t.Object({
  conversationId: t.String({ format: 'uuid' }),
});

export const workChatAttachmentParamsSchema = t.Object({
  conversationId: t.String({ format: 'uuid' }),
  attachmentId: t.String({ format: 'uuid' }),
});

export const workChatAttachmentUploadSchema = t.Object(
  { file: t.File() },
  { additionalProperties: false },
);

export const workChatConversationListQuerySchema = t.Object(
  {
    limit: t.Optional(t.Integer({ minimum: 1, maximum: 20 })),
    cursor: t.Optional(t.String()),
  },
  { additionalProperties: false },
);

export const workChatMessageListQuerySchema = t.Object(
  {
    limit: t.Optional(t.Integer({ minimum: 1, maximum: 50 })),
    before: t.Optional(t.String()),
    after: t.Optional(t.String()),
  },
  { additionalProperties: false },
);

export const workChatSendMessageSchema = t.Object(
  {
    clientMessageId: t.String({ minLength: 1, maxLength: 128, pattern: '\\S' }),
    text: t.Optional(t.String({ minLength: 1, maxLength: 1000, pattern: '\\S' })),
    attachmentIds: t.Optional(t.Array(t.String({ format: 'uuid' }), { maxItems: 5, uniqueItems: true })),
  },
  { additionalProperties: false },
);

export const workChatReadCursorSchema = t.Object(
  {
    messageId: t.String({ format: 'uuid' }),
  },
  { additionalProperties: false },
);

export const workChatConversationListResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    items: t.Array(conversationSchema),
    nextCursor: t.Nullable(t.String()),
  }),
});

export const workChatMessageListResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    items: t.Array(messageSchema),
    nextCursor: t.Nullable(t.String()),
    hasMore: t.Boolean(),
  }),
});

export const workChatMessageResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({ message: messageSchema }),
});

export const workChatParticipantListResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    participants: t.Array(participantSchema),
  }),
});

export const workChatAttachmentResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({ attachment: attachmentSchema }),
});

export const workChatAttachmentLinkResponseSchema = t.Object({
  success: t.Literal(true),
  data: workChatAttachmentLinkSchema,
});

export const workChatAttachmentDiscardResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({ attachmentId: t.String({ format: 'uuid' }) }),
});

export const workChatReadCursorResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    conversationId: t.String({ format: 'uuid' }),
    messageId: t.String({ format: 'uuid' }),
  }),
});

export type WorkChatConversationListQuery = typeof workChatConversationListQuerySchema.static;
export type WorkChatMessageListQuery = typeof workChatMessageListQuerySchema.static;
export type WorkChatConversationParams = typeof workChatConversationParamsSchema.static;
export type WorkChatAttachmentParams = typeof workChatAttachmentParamsSchema.static;
export type WorkChatAttachmentUploadInput = typeof workChatAttachmentUploadSchema.static;
export type WorkChatSendMessageInput = typeof workChatSendMessageSchema.static;
export type WorkChatReadCursorInput = typeof workChatReadCursorSchema.static;
