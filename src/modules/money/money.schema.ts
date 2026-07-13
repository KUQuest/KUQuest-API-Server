import { t } from 'elysia';

export const problemSchema = t.Object({
  type: t.String(),
  title: t.String(),
  status: t.Integer({ minimum: 400, maximum: 599 }),
  code: t.String(),
  detail: t.String(),
  trace_id: t.String(),
});

export const walletSchema = t.Object({
  id: t.String(),
  currency: t.Literal('THB'),
  spending_balance: t.Integer({ minimum: 0 }),
  earnings_balance: t.Integer({ minimum: 0 }),
  held_for_jobs: t.Integer({ minimum: 0 }),
  reserved_for_payouts: t.Integer({ minimum: 0 }),
  status: t.Union([t.Literal('ACTIVE'), t.Literal('FROZEN')]),
  as_of: t.String({ format: 'date-time' }),
});

const amountRangeSchema = t.Object({
  minimum: t.Integer({ minimum: 1 }),
  maximum: t.Integer({ minimum: 1 }),
});

export const moneyPolicySchema = t.Object({
  revision: t.Integer({ minimum: 1 }),
  currency: t.Literal('THB'),
  platform_fee_bps: t.Literal(200),
  fee_rounding: t.Literal('UP_TO_WHOLE_BAHT'),
  quote_ttl_seconds: t.Literal(300),
  review_window_seconds: t.Literal(86400),
  default_application_window_seconds: t.Literal(604800),
  high_value_resolution_threshold: t.Integer({ minimum: 1 }),
  limits: t.Object({
    top_up: amountRangeSchema,
    funded_job: amountRangeSchema,
    earnings_conversion: amountRangeSchema,
    payout: amountRangeSchema,
  }),
  effective_at: t.String({ format: 'date-time' }),
});

export const activityTypeSchema = t.Union([
  t.Literal('TOP_UP'),
  t.Literal('JOB_FUNDING'),
  t.Literal('JOB_RETURN'),
  t.Literal('JOB_SETTLEMENT'),
  t.Literal('PLATFORM_FEE'),
  t.Literal('EARNINGS_CONVERSION'),
  t.Literal('PAYOUT'),
  t.Literal('PAYOUT_RELEASE'),
  t.Literal('WALLET_ADJUSTMENT'),
]);

export const walletActivitySchema = t.Object({
  id: t.String(),
  type: activityTypeSchema,
  title: t.String(),
  status: t.String(),
  spending_delta: t.Integer(),
  earnings_delta: t.Integer(),
  held_jobs_delta: t.Integer(),
  reserved_payouts_delta: t.Integer(),
  currency: t.Literal('THB'),
  occurred_at: t.String({ format: 'date-time' }),
  resource: t.Object({
    type: t.Union([
      t.Literal('TOP_UP'),
      t.Literal('JOB'),
      t.Literal('CONVERSION'),
      t.Literal('PAYOUT'),
      t.Literal('ADJUSTMENT'),
    ]),
    id: t.String(),
  }),
});

export const activityPageSchema = t.Object({
  items: t.Array(walletActivitySchema),
  next_cursor: t.Union([t.String(), t.Null()]),
});

export const conversionRequestSchema = t.Object({
  amount: t.Integer({ minimum: 1 }),
});

export const earningsConversionSchema = t.Object({
  id: t.String(),
  amount: t.Integer({ minimum: 1 }),
  currency: t.Literal('THB'),
  earnings_balance_after: t.Integer({ minimum: 0 }),
  spending_balance_after: t.Integer({ minimum: 0 }),
  created_at: t.String({ format: 'date-time' }),
});
