import { t } from 'elysia';

const dateTime = t.String({ format: 'date-time' });

export const walletBalanceSchema = t.Object({
  spendingBalanceSatang: t.Integer({ minimum: 0 }),
  earningsBalanceSatang: t.Integer({ minimum: 0 }),
  fundingReservedSatang: t.Integer({ minimum: 0 }),
  reservedForPayoutsSatang: t.Integer({ minimum: 0 }),
});

export const walletResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    wallet: walletBalanceSchema,
  }),
});

export const earningsConversionCreateSchema = t.Object({
  amountSatang: t.Integer({ minimum: 1 }),
}, { additionalProperties: false });

export const earningsConversionHeadersSchema = t.Object({
  'idempotency-key': t.String({ minLength: 1, maxLength: 200, pattern: '\\S' }),
});

export const earningsConversionResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    id: t.String({ format: 'uuid' }),
    principalUserId: t.String({ format: 'uuid' }),
    amountSatang: t.Integer({ minimum: 1 }),
    businessReference: t.String(),
    ledgerTransactionId: t.String({ format: 'uuid' }),
    createdAt: dateTime,
  }),
});

export const walletActivitiesQuerySchema = t.Object({
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
});

export const walletActivitySchema = t.Object({
  id: t.String({ format: 'uuid' }),
  userId: t.String({ format: 'uuid' }),
  ledgerTransactionId: t.String({ format: 'uuid' }),
  occurredAt: dateTime,
  type: t.String(),
  activityStatus: t.String(),
  spendingDeltaSatang: t.Integer(),
  earningsDeltaSatang: t.Integer(),
  fundingReservedDeltaSatang: t.Integer(),
  payoutReservedDeltaSatang: t.Integer(),
  resourceType: t.Union([t.String(), t.Null()]),
  resourceId: t.Union([t.String(), t.Null()]),
});

export const walletActivitiesResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    activities: t.Array(walletActivitySchema),
  }),
});
