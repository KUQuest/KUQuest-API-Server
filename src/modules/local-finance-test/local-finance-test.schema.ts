import { t } from 'elysia';

export const walletBalanceSchema = t.Object({
  spendingBalanceSatang: t.Integer({ minimum: 0 }),
  earningsBalanceSatang: t.Integer({ minimum: 0 }),
  fundingReservedSatang: t.Integer({ minimum: 0 }),
  reservedForPayoutsSatang: t.Integer({ minimum: 0 }),
});

const topUpSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  internalReference: t.String(),
  providerReference: t.Nullable(t.String()),
  providerStatus: t.Nullable(t.String()),
  providerChannelCode: t.Nullable(t.String()),
  creditSatang: t.Integer({ minimum: 1 }),
  paymentTotalSatang: t.Integer({ minimum: 1 }),
  qrPayload: t.Nullable(t.String()),
  qrDataUrl: t.Nullable(t.String()),
  qrExpiresAt: t.Nullable(t.String({ format: 'date-time' })),
  topUpStatus: t.String(),
});

export const localTestPaymentBodySchema = t.Object({
  creditSatang: t.Optional(t.Integer({ minimum: 100, maximum: 70_000_000 })),
  simulate: t.Optional(t.Boolean()),
}, { additionalProperties: false });

export const localTestPaymentResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    testUserEmail: t.String({ format: 'email' }),
    simulated: t.Boolean(),
    callbackReceived: t.Boolean(),
    reconciliationUsed: t.Boolean(),
    topUp: topUpSchema,
    wallet: walletBalanceSchema,
  }),
});

export const localTestWalletResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    testUserEmail: t.String({ format: 'email' }),
    wallet: walletBalanceSchema,
  }),
});

export const localTestTransferBodySchema = t.Object({
  amountSatang: t.Optional(t.Integer({ minimum: 100, maximum: 70_000_000 })),
}, { additionalProperties: false });

export const localTestTransferResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    payerEmail: t.String({ format: 'email' }),
    recipientEmail: t.String({ format: 'email' }),
    amountSatang: t.Integer({ minimum: 1 }),
    reservation: t.Object({
      id: t.String({ format: 'uuid' }),
      status: t.String(),
      remainingSatang: t.Integer({ minimum: 0 }),
    }),
    settlement: t.Object({
      id: t.String({ format: 'uuid' }),
      ledgerTransactionId: t.String({ format: 'uuid' }),
      recipientAmountSatang: t.Integer({ minimum: 1 }),
      totalAmountSatang: t.Integer({ minimum: 1 }),
    }),
    payerWallet: walletBalanceSchema,
    recipientWallet: walletBalanceSchema,
  }),
});
