import { t } from 'elysia';

export const payoutStatusSchema = t.Union([
  t.Literal('PENDING_ADMIN_APPROVAL'),
  t.Literal('CREATING'),
  t.Literal('PENDING'),
  t.Literal('AWAITING_RECONCILIATION'),
  t.Literal('COMPLETED'),
  t.Literal('FAILED'),
  t.Literal('CANCELLED'),
]);

const dateTime = t.String({ format: 'date-time' });

export const payoutQuoteCreateSchema = t.Object({
  receiptSatang: t.Integer({ minimum: 1 }),
}, { additionalProperties: false });

export const payoutCreateSchema = t.Object({
  quoteId: t.String({ format: 'uuid' }),
}, { additionalProperties: false });

export const payoutIdempotencyHeadersSchema = t.Object({
  'idempotency-key': t.String({ minLength: 1, maxLength: 200, pattern: '\\S' }),
});

export const payoutParamsSchema = t.Object({
  payoutId: t.String({ format: 'uuid' }),
});

export const payoutListQuerySchema = t.Object({
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 50 })),
});

export const payoutQuoteResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    id: t.String({ format: 'uuid' }),
    principalUserId: t.String({ format: 'uuid' }),
    payoutDestinationId: t.String({ format: 'uuid' }),
    policyRevisionId: t.String({ format: 'uuid' }),
    receiptSatang: t.Integer({ minimum: 1 }),
    maximumFeeSatang: t.Integer({ minimum: 0 }),
    maximumTaxSatang: t.Integer({ minimum: 0 }),
    maximumDebitSatang: t.Integer({ minimum: 1 }),
    feeRoundingMode: t.Literal('UP'),
    expiresAt: dateTime,
    consumedAt: t.Union([dateTime, t.Null()]),
    createdAt: dateTime,
  }),
});

const payoutDataSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  internalReference: t.String(),
  principalUserId: t.String({ format: 'uuid' }),
  quoteId: t.String({ format: 'uuid' }),
  payoutDestinationId: t.String({ format: 'uuid' }),
  destinationRecipientType: t.String(),
  destinationGivenName: t.String(),
  destinationSurname: t.String(),
  destinationRelationship: t.String(),
  destinationAccountCountry: t.String(),
  destinationAccountCurrency: t.String(),
  destinationBankCode: t.String(),
  destinationAccountHolderName: t.String(),
  destinationRoutingType: t.String(),
  destinationMaskedLastFour: t.String(),
  destinationMaskedRoutingValue: t.String(),
  provider: t.String(),
  providerReference: t.Union([t.String(), t.Null()]),
  providerApiVersion: t.Union([t.String(), t.Null()]),
  providerStatus: t.Union([t.String(), t.Null()]),
  providerAmountSatang: t.Union([t.Integer({ minimum: 1 }), t.Null()]),
  principalSatang: t.Integer({ minimum: 1 }),
  receiptSatang: t.Integer({ minimum: 1 }),
  maximumFeeSatang: t.Integer({ minimum: 0 }),
  maximumTaxSatang: t.Integer({ minimum: 0 }),
  maximumDebitSatang: t.Integer({ minimum: 1 }),
  actualFeeSatang: t.Union([t.Integer({ minimum: 0 }), t.Null()]),
  actualTaxSatang: t.Union([t.Integer({ minimum: 0 }), t.Null()]),
  actualDebitSatang: t.Union([t.Integer({ minimum: 1 }), t.Null()]),
  payoutStatus: payoutStatusSchema,
  reserveLedgerTransactionId: t.String({ format: 'uuid' }),
  finalLedgerTransactionId: t.Union([t.String({ format: 'uuid' }), t.Null()]),
  createdAt: dateTime,
  updatedAt: dateTime,
});

export const payoutResponseSchema = t.Object({
  success: t.Literal(true),
  data: payoutDataSchema,
});

export const payoutListResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    items: t.Array(payoutDataSchema),
    nextCursor: t.Null(),
  }),
});

export const payoutStatusHistoryResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Array(t.Object({
    id: t.String({ format: 'uuid' }),
    fromStatus: t.Union([payoutStatusSchema, t.Null()]),
    toStatus: payoutStatusSchema,
    providerStatus: t.Union([t.String(), t.Null()]),
    actorUserId: t.Union([t.String({ format: 'uuid' }), t.Null()]),
    actorAdminId: t.Union([t.String({ format: 'uuid' }), t.Null()]),
    source: t.String(),
    reason: t.Union([t.String(), t.Null()]),
    occurredAt: dateTime,
  })),
});

export type PayoutCreateInput = typeof payoutCreateSchema.static;
export type PayoutListQuery = typeof payoutListQuerySchema.static;
export type PayoutQuoteCreateInput = typeof payoutQuoteCreateSchema.static;
