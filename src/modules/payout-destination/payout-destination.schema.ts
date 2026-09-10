import { t } from 'elysia';

const dateTime = t.String({ format: 'date-time' });

export const payoutDestinationDataSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  principalUserId: t.String({ format: 'uuid' }),
  recipientType: t.Literal('SELF'),
  givenName: t.String(),
  surname: t.String(),
  relationship: t.Literal('SELF'),
  accountCountry: t.Literal('TH'),
  accountCurrency: t.Literal('THB'),
  bankCode: t.String(),
  accountHolderName: t.String(),
  routingType: t.Union([t.Literal('BANK_ACCOUNT'), t.Literal('PROMPTPAY')]),
  maskedLastFour: t.String(),
  maskedRoutingValue: t.String(),
  createdAt: dateTime,
  retiredAt: t.Union([dateTime, t.Null()]),
});

export const payoutDestinationResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Union([payoutDestinationDataSchema, t.Null()]),
});

export const payoutDestinationCreateSchema = t.Object({
  recipientType: t.Optional(t.Literal('SELF')),
  givenName: t.String({ minLength: 1, maxLength: 100 }),
  surname: t.String({ minLength: 1, maxLength: 100 }),
  relationship: t.Optional(t.Literal('SELF')),
  accountHolderName: t.String({ minLength: 1, maxLength: 200 }),
  bankCode: t.String({ minLength: 1, maxLength: 20 }),
  accountNumber: t.String({ minLength: 1, maxLength: 64 }),
  accountCountry: t.Optional(t.Literal('TH')),
  accountCurrency: t.Optional(t.Literal('THB')),
  routingType: t.Optional(t.Union([t.Literal('BANK_ACCOUNT'), t.Literal('PROMPTPAY')])),
  routingValue: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
}, { additionalProperties: false });

export const payoutDestinationRetireResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    retired: t.Literal(true),
  }),
});
