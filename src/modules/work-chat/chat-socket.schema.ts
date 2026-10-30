import { Value } from '@sinclair/typebox/value';
import { t } from 'elysia';

export const chatSocketSendMessageSchema = t.Object(
  {
    type: t.Literal('SEND_MESSAGE'),
    clientMessageId: t.String({ minLength: 1, maxLength: 128, pattern: '\\S' }),
    text: t.Optional(t.String({ minLength: 1, maxLength: 1000, pattern: '\\S' })),
    attachmentIds: t.Optional(t.Array(t.String({ format: 'uuid' }), { uniqueItems: true })),
  },
  { additionalProperties: false }
);

export const chatSocketMessageAcceptedSchema = t.Object({
  type: t.Literal('MESSAGE_ACCEPTED'),
  clientMessageId: t.String(),
  message: t.Unknown(),
});

export const chatSocketMessageRejectedSchema = t.Object({
  type: t.Literal('MESSAGE_REJECTED'),
  clientMessageId: t.Nullable(t.String()),
  error: t.Object({
    code: t.String(),
    message: t.String(),
  }),
});

export const chatSocketAcknowledgementSchema = t.Union([
  chatSocketMessageAcceptedSchema,
  chatSocketMessageRejectedSchema,
]);

export type ChatSocketSendMessage = typeof chatSocketSendMessageSchema.static;
export type ChatSocketMessageAccepted = typeof chatSocketMessageAcceptedSchema.static;
export type ChatSocketMessageRejected = typeof chatSocketMessageRejectedSchema.static;
export type ChatSocketAcknowledgement = typeof chatSocketAcknowledgementSchema.static;

const decodeSocketPayload = (payload: unknown): unknown => {
  if (typeof payload === 'string') {
    try {
      return JSON.parse(payload);
    } catch {
      return undefined;
    }
  }

  if (payload instanceof ArrayBuffer) {
    try {
      return JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return undefined;
    }
  }

  if (ArrayBuffer.isView(payload)) {
    try {
      return JSON.parse(
        new TextDecoder().decode(
          new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
        )
      );
    } catch {
      return undefined;
    }
  }

  return payload;
};

export const parseChatSocketSendMessage = (payload: unknown): ChatSocketSendMessage | null => {
  const decoded = decodeSocketPayload(payload);
  return Value.Check(chatSocketSendMessageSchema, decoded)
    ? (decoded as ChatSocketSendMessage)
    : null;
};

export const extractChatSocketClientMessageId = (payload: unknown): string | null => {
  const decoded = decodeSocketPayload(payload);
  if (typeof decoded !== 'object' || decoded === null || !('clientMessageId' in decoded))
    return null;
  const clientMessageId = decoded.clientMessageId;
  return typeof clientMessageId === 'string' &&
    clientMessageId.trim().length > 0 &&
    clientMessageId.length <= 128
    ? clientMessageId
    : null;
};

export const serializeChatSocketMessage = <
  Message extends {
    createdAt: Date;
    attachments: Array<{ createdAt: Date }>;
  },
>(
  message: Message
) => ({
  ...message,
  createdAt: message.createdAt.toISOString(),
  attachments: message.attachments.map((attachment) => ({
    ...attachment,
    createdAt: attachment.createdAt.toISOString(),
  })),
});
