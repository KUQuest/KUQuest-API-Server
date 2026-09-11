import { t } from 'elysia';

import { topUpDataSchema } from './top-up.schema';

const dateTime = t.String({ format: 'date-time' });

export const adminTopUpParamsSchema = t.Object({
  topUpId: t.String({ format: 'uuid' }),
});

export const adminTopUpEventParamsSchema = t.Object({
  eventId: t.String({ format: 'uuid' }),
});

export const adminTopUpResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    topUp: topUpDataSchema,
  }),
});

export const adminTopUpEventDataSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  provider: t.String(),
  providerEventId: t.String(),
  eventType: t.String(),
  resourceType: t.String(),
  internalReference: t.Union([t.String(), t.Null()]),
  providerReference: t.Union([t.String(), t.Null()]),
  providerApiVersion: t.Union([t.String(), t.Null()]),
  providerStatus: t.String(),
  normalizedStatus: t.String(),
  providerAmountSatang: t.Union([t.Integer({ minimum: 1 }), t.Null()]),
  providerChannelCode: t.Union([t.String(), t.Null()]),
  providerOccurredAt: dateTime,
  payloadHash: t.String(),
  rawPayloadAvailable: t.Boolean(),
  rawPayloadExpiresAt: dateTime,
  processingStatus: t.String(),
  attemptCount: t.Integer({ minimum: 0 }),
  claimedAt: t.Union([dateTime, t.Null()]),
  processedAt: t.Union([dateTime, t.Null()]),
  lastError: t.Union([t.String(), t.Null()]),
  receivedAt: dateTime,
  createdAt: dateTime,
});

export const adminTopUpEventResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    event: adminTopUpEventDataSchema,
  }),
});

export type AdminTopUpParams = typeof adminTopUpParamsSchema.static;
export type AdminTopUpEventParams = typeof adminTopUpEventParamsSchema.static;

export const adminTopUpListItemSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  userId: t.String({ format: 'uuid' }),
  member: t.Object({
    firstName: t.String(),
    lastName: t.String(),
    studentId: t.Union([t.String(), t.Null()]),
  }),
  topUpStatus: t.String(),
  creditAmountSatang: t.Integer({ minimum: 1 }),
  providerFeeSatang: t.Integer({ minimum: 0 }),
  providerTaxSatang: t.Integer({ minimum: 0 }),
  paymentTotalSatang: t.Integer({ minimum: 1 }),
  paymentMethod: t.String(),
  providerReference: t.Union([t.String(), t.Null()]),
  expiresAt: dateTime,
  paidAt: t.Union([dateTime, t.Null()]),
  createdAt: dateTime,
});

export const adminTopUpListQuerySchema = t.Object({
  status: t.Optional(
    t.Union([
      t.Literal('PENDING'),
      t.Literal('PAID'),
      t.Literal('EXPIRED'),
      t.Literal('FAILED'),
    ]),
  ),
  userId: t.Optional(t.String({ format: 'uuid' })),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
  cursor: t.Optional(t.String()),
});

export const adminTopUpListResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    items: t.Array(adminTopUpListItemSchema),
    nextCursor: t.Union([t.String(), t.Null()]),
  }),
});

export type AdminTopUpListQuery = typeof adminTopUpListQuerySchema.static;
export type AdminTopUpListItem = typeof adminTopUpListItemSchema.static;
