import { t } from 'elysia';

import { payoutResponseSchema, payoutStatusSchema } from './payout.schema';

export const adminPayoutParamsSchema = t.Object({
  payoutId: t.String({ format: 'uuid' }),
});

export const adminPayoutEventParamsSchema = t.Object({
  eventId: t.String({ format: 'uuid' }),
});

export const adminPayoutHeadersSchema = t.Object({
  'idempotency-key': t.String({ minLength: 1, maxLength: 200, pattern: '\\S' }),
  'if-match': t.String({ minLength: 1, maxLength: 100, pattern: '^[1-9]\\d*$' }),
});

export const adminPayoutListQuerySchema = t.Object({
  status: t.Optional(payoutStatusSchema),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 50 })),
  cursor: t.Optional(t.String()),
  sort: t.Optional(t.Union([t.Literal('newest'), t.Literal('oldest')])),
});

const adminPayoutReasonCodeSchema = t.String({
  minLength: 1,
  maxLength: 100,
  pattern: '^[A-Z][A-Z0-9_.-]*$',
});

export const adminPayoutApprovalSchema = t.Object({
  reasonCode: adminPayoutReasonCodeSchema,
}, { additionalProperties: false });

export const adminPayoutCancellationSchema = t.Object({
  reasonCode: adminPayoutReasonCodeSchema,
}, { additionalProperties: false });

const adminPayoutDataSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  student: t.Object({
    id: t.String({ format: 'uuid' }),
    email: t.String(),
    firstName: t.String(),
    lastName: t.String(),
  }),
  quoteId: t.String({ format: 'uuid' }),
  principalSatang: t.Integer({ minimum: 1 }),
  receiptSatang: t.Integer({ minimum: 1 }),
  maximumFeeSatang: t.Integer({ minimum: 0 }),
  maximumTaxSatang: t.Integer({ minimum: 0 }),
  maximumDebitSatang: t.Integer({ minimum: 1 }),
  actualFeeSatang: t.Union([t.Integer({ minimum: 0 }), t.Null()]),
  actualTaxSatang: t.Union([t.Integer({ minimum: 0 }), t.Null()]),
  actualDebitSatang: t.Union([t.Integer({ minimum: 1 }), t.Null()]),
  bankCode: t.String(),
  bankName: t.String(),
  destinationType: t.String(),
  maskedDestinationValue: t.String(),
  maskedRoutingValue: t.String(),
  providerReference: t.Union([t.String(), t.Null()]),
  providerStatus: t.Union([t.String(), t.Null()]),
  payoutStatus: payoutStatusSchema,
  cancellationReasonCode: t.Union([t.String(), t.Null()]),
  version: t.Integer({ minimum: 1 }),
  createdAt: t.String({ format: 'date-time' }),
  updatedAt: t.String({ format: 'date-time' }),
});

const adminPayoutHistoryEntrySchema = t.Object({
  id: t.String({ format: 'uuid' }),
  fromStatus: t.Union([payoutStatusSchema, t.Null()]),
  toStatus: payoutStatusSchema,
  providerStatus: t.Union([t.String(), t.Null()]),
  actorUserId: t.Union([t.String({ format: 'uuid' }), t.Null()]),
  actorAdminId: t.Union([t.String({ format: 'uuid' }), t.Null()]),
  source: t.String(),
  reason: t.Union([t.String(), t.Null()]),
  occurredAt: t.String({ format: 'date-time' }),
});

export const adminPayoutCommandResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    resourceSummary: adminPayoutDataSchema,
    resourceVersion: t.Integer({ minimum: 1 }),
    adminActionId: t.String({ format: 'uuid' }),
  }),
});

export const adminPayoutDetailResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Intersect([
    adminPayoutDataSchema,
    t.Object({ history: t.Array(adminPayoutHistoryEntrySchema) }),
  ]),
});

export const adminPayoutListResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    items: t.Array(adminPayoutDataSchema),
    nextCursor: t.Union([t.String(), t.Null()]),
  }),
});

export const adminPayoutHistoryResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Array(adminPayoutHistoryEntrySchema),
});
const dateTime = t.String({ format: 'date-time' });

export const adminPayoutReconcileResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    payout: payoutResponseSchema.properties.data,
  }),
});

export const adminPayoutEventDataSchema = t.Object({
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
  actualFeeSatang: t.Union([t.Integer({ minimum: 0 }), t.Null()]),
  actualTaxSatang: t.Union([t.Integer({ minimum: 0 }), t.Null()]),
  actualDebitSatang: t.Union([t.Integer({ minimum: 1 }), t.Null()]),
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

export const adminPayoutEventResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    event: adminPayoutEventDataSchema,
  }),
});

export type AdminPayoutListQuery = typeof adminPayoutListQuerySchema.static;
export type AdminPayoutApprovalInput = typeof adminPayoutApprovalSchema.static;
export type AdminPayoutCancellationInput = typeof adminPayoutCancellationSchema.static;
export type AdminPayoutEventParams = typeof adminPayoutEventParamsSchema.static;
