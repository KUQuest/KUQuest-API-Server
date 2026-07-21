import { t } from 'elysia';

export const topUpSchema = t.Object({
  id: t.String(),
  reference: t.String(),
  credit_baht: t.Integer(),
  payment_total_baht: t.Integer(),
  currency: t.Literal('THB'),
  status: t.String(),
  qr_string: t.Nullable(t.String()),
  qr_expires_at: t.Nullable(t.String()),
  provider_reference: t.Nullable(t.String()),
  created_at: t.String(),
  updated_at: t.String(),
});

export const topUpQuoteSchema = t.Object({
  id: t.String(),
  credit_baht: t.Integer(),
  fee_baht: t.Integer(),
  tax_baht: t.Integer(),
  payment_total_baht: t.Integer(),
  currency: t.Literal('THB'),
  expires_at: t.String(),
});

export const payoutAccountSchema = t.Object({
  id: t.String(),
  given_name: t.String(),
  surname: t.String(),
  account_holder_name: t.String(),
  bank_code: t.String(),
  masked_account_number: t.String(),
  created_at: t.String(),
});

export const payoutAccountInputSchema = t.Object({
  given_name: t.String({ minLength: 1, maxLength: 50 }),
  surname: t.String({ minLength: 1, maxLength: 50 }),
  account_holder_name: t.String({ minLength: 1, maxLength: 100 }),
  account_number: t.String({ minLength: 6, maxLength: 32 }),
  bank_code: t.String({ minLength: 2, maxLength: 30 }),
});

export const payoutQuoteSchema = t.Object({
  id: t.String(),
  payout_account_id: t.String(),
  receipt_baht: t.Integer(),
  maximum_fee_baht: t.Integer(),
  maximum_tax_baht: t.Integer(),
  maximum_debit_baht: t.Integer(),
  currency: t.Literal('THB'),
  expires_at: t.String(),
});

export const payoutSchema = t.Object({
  id: t.String(),
  reference: t.String(),
  principal_baht: t.Integer(),
  maximum_debit_baht: t.Integer(),
  currency: t.Literal('THB'),
  status: t.String(),
  destination: t.Object({
    bank_code: t.String(),
    masked_account_number: t.String(),
  }),
  provider_reference: t.Nullable(t.String()),
  created_at: t.String(),
  updated_at: t.String(),
});

export const resourceIdParamsSchema = t.Object({
  id: t.String({ format: 'uuid' }),
});

export const quoteIdBodySchema = t.Object({
  quote_id: t.String({ format: 'uuid' }),
});

export const idempotencyHeadersSchema = t.Object({
  'idempotency-key': t.String({ minLength: 8, maxLength: 128 }),
});
