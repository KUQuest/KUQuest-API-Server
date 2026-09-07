import { t } from 'elysia';

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
