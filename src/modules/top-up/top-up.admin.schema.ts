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
