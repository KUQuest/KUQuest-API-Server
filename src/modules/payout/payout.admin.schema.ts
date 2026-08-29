import { t } from 'elysia';

import { payoutStatusSchema } from './payout.schema';

export const adminPayoutParamsSchema = t.Object({
  payoutId: t.String({ format: 'uuid' }),
});

export const adminPayoutHeadersSchema = t.Object({
  'idempotency-key': t.String({ minLength: 1, maxLength: 200, pattern: '\\S' }),
});

export const adminPayoutListQuerySchema = t.Object({
  status: t.Optional(payoutStatusSchema),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 50 })),
  cursor: t.Optional(t.String()),
  sort: t.Optional(t.Union([t.Literal('newest'), t.Literal('oldest')])),
});

export const adminPayoutApprovalSchema = t.Object({
  note: t.Optional(t.String({ maxLength: 500 })),
}, { additionalProperties: false });

export const adminPayoutRejectionSchema = t.Object({
  reason: t.String({ minLength: 1, maxLength: 500, pattern: '\\S' }),
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
  rejectionReason: t.Union([t.String(), t.Null()]),
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

export const adminPayoutResponseSchema = t.Object({
  success: t.Literal(true),
  data: adminPayoutDataSchema,
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

export type AdminPayoutListQuery = typeof adminPayoutListQuerySchema.static;
export type AdminPayoutApprovalInput = typeof adminPayoutApprovalSchema.static;
export type AdminPayoutRejectionInput = typeof adminPayoutRejectionSchema.static;
