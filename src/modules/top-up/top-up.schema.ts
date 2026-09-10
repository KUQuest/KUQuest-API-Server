import { t } from 'elysia';

export const topUpStatusSchema = t.Union([
  t.Literal('PENDING'),
  t.Literal('PAID'),
  t.Literal('EXPIRED'),
  t.Literal('FAILED'),
]);

const dateTime = t.String({ format: 'date-time' });

export const topUpQuoteCreateSchema = t.Object({
  creditSatang: t.Integer({ minimum: 1 }),
}, { additionalProperties: false });

export const topUpCreateSchema = t.Object({
  quoteId: t.String({ format: 'uuid' }),
  simulate: t.Optional(t.Boolean()),
}, { additionalProperties: false });

export const topUpIdempotencyHeadersSchema = t.Object({
  'idempotency-key': t.String({ minLength: 1, maxLength: 200, pattern: '\\S' }),
});

export const topUpParamsSchema = t.Object({
  topUpId: t.String({ format: 'uuid' }),
});

export const topUpListQuerySchema = t.Object({
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 50 })),
});

export const topUpQuoteResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    id: t.String({ format: 'uuid' }),
    principalUserId: t.String({ format: 'uuid' }),
    policyRevisionId: t.String({ format: 'uuid' }),
    creditSatang: t.Integer({ minimum: 1 }),
    chargedFeeSatang: t.Integer({ minimum: 0 }),
    chargedTaxSatang: t.Integer({ minimum: 0 }),
    paymentTotalSatang: t.Integer({ minimum: 1 }),
    providerFeeSatang: t.Integer({ minimum: 0 }),
    providerTaxSatang: t.Integer({ minimum: 0 }),
    providerTotalSatang: t.Integer({ minimum: 1 }),
    feeRoundingMode: t.Literal('UP'),
    expiresAt: dateTime,
    consumedAt: t.Union([dateTime, t.Null()]),
    createdAt: dateTime,
  }),
});

export const topUpDataSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  internalReference: t.String(),
  principalUserId: t.String({ format: 'uuid' }),
  quoteId: t.String({ format: 'uuid' }),
  provider: t.String(),
  providerReference: t.Union([t.String(), t.Null()]),
  providerApiVersion: t.Union([t.String(), t.Null()]),
  providerStatus: t.Union([t.String(), t.Null()]),
  providerAmountSatang: t.Union([t.Integer({ minimum: 1 }), t.Null()]),
  providerChannelCode: t.Union([t.String(), t.Null()]),
  creditSatang: t.Integer({ minimum: 1 }),
  chargedFeeSatang: t.Integer({ minimum: 0 }),
  chargedTaxSatang: t.Integer({ minimum: 0 }),
  paymentTotalSatang: t.Integer({ minimum: 1 }),
  providerFeeSatang: t.Integer({ minimum: 0 }),
  providerTaxSatang: t.Integer({ minimum: 0 }),
  providerTotalSatang: t.Integer({ minimum: 1 }),
  qrPayload: t.Union([t.String(), t.Null()]),
  qrDataUrl: t.Union([t.String(), t.Null()]),
  qrExpiresAt: t.Union([dateTime, t.Null()]),
  topUpStatus: topUpStatusSchema,
  creditedLedgerTransactionId: t.Union([t.String({ format: 'uuid' }), t.Null()]),
  createdAt: dateTime,
  updatedAt: dateTime,
  simulated: t.Optional(t.Boolean()),
  callbackReceived: t.Optional(t.Boolean()),
  reconciliationUsed: t.Optional(t.Boolean()),
});

export const topUpResponseSchema = t.Object({
  success: t.Literal(true),
  data: topUpDataSchema,
});

export const topUpListResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    items: t.Array(topUpDataSchema),
    nextCursor: t.Null(),
  }),
});

export const topUpStatusHistoryResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Array(t.Object({
    id: t.String({ format: 'uuid' }),
    fromStatus: t.Union([topUpStatusSchema, t.Null()]),
    toStatus: topUpStatusSchema,
    providerStatus: t.Union([t.String(), t.Null()]),
    actorUserId: t.Union([t.String({ format: 'uuid' }), t.Null()]),
    actorAdminId: t.Union([t.String({ format: 'uuid' }), t.Null()]),
    source: t.String(),
    reason: t.Union([t.String(), t.Null()]),
    occurredAt: dateTime,
  })),
});

export type TopUpCreateInput = typeof topUpCreateSchema.static;
export type TopUpListQuery = typeof topUpListQuerySchema.static;
export type TopUpQuoteCreateInput = typeof topUpQuoteCreateSchema.static;
