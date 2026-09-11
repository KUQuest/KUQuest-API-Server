import { type Static, t } from 'elysia';

import { walletBalanceSchema } from './wallet.schema';

const dateTime = t.String({ format: 'date-time' });
const uuid = t.String({ format: 'uuid' });

export const adminWalletListItemSchema = t.Object({
  id: uuid,
  userId: uuid,
  member: t.Object({
    firstName: t.String(),
    lastName: t.String(),
    studentId: t.Union([t.String(), t.Null()]),
    email: t.String(),
    telephone: t.Union([t.String(), t.Null()]),
  }),
  walletStatus: t.String(),
  balances: t.Object({
    spendingBalanceSatang: t.Integer(),
    earningsBalanceSatang: t.Integer(),
    fundingReservedSatang: t.Integer(),
    reservedForPayoutsSatang: t.Integer(),
    totalBalanceSatang: t.Integer(),
  }),
  createdAt: dateTime,
  updatedAt: dateTime,
});

export const adminWalletListQuerySchema = t.Object({
  status: t.Optional(
    t.Union([
      t.Literal('ACTIVE'),
      t.Literal('FROZEN'),
      t.Literal('SUSPENDED'),
      t.Literal('CLOSED'),
    ]),
  ),
  userId: t.Optional(uuid),
  search: t.Optional(t.String()),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
  cursor: t.Optional(t.String()),
});

export const adminWalletListResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    items: t.Array(adminWalletListItemSchema),
    nextCursor: t.Union([t.String(), t.Null()]),
  }),
});

export const adminWalletFullDetailResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    wallet: t.Object({
      id: uuid,
      userId: uuid,
      member: t.Object({
        firstName: t.String(),
        lastName: t.String(),
        studentId: t.Union([t.String(), t.Null()]),
        email: t.String(),
        telephone: t.Union([t.String(), t.Null()]),
      }),
      walletStatus: t.String(),
      balances: t.Object({
        spendingBalanceSatang: t.Integer(),
        earningsBalanceSatang: t.Integer(),
        fundingReservedSatang: t.Integer(),
        reservedForPayoutsSatang: t.Integer(),
        totalBalanceSatang: t.Integer(),
      }),
      projectionMatchesLedger: t.Boolean(),
      createdAt: dateTime,
      updatedAt: dateTime,
    }),
  }),
});

export const adminWalletParamsSchema = t.Object({
  walletId: t.String({ format: 'uuid' }),
});

export const adminWalletStatusChangeSchema = t.Object({
  toStatus: t.Union([
    t.Literal('ACTIVE'),
    t.Literal('FROZEN'),
    t.Literal('SUSPENDED'),
    t.Literal('CLOSED'),
  ]),
  reason: t.String({ minLength: 1, maxLength: 500 }),
});

export const adminWalletStatusChangeHeadersSchema = t.Object({
  'idempotency-key': t.String({ minLength: 1 }),
});

export const adminWalletDetailSchema = t.Object({
  spendingBalanceSatang: t.Integer({ minimum: 0 }),
  earningsBalanceSatang: t.Integer({ minimum: 0 }),
  fundingReservedSatang: t.Integer({ minimum: 0 }),
  reservedForPayoutsSatang: t.Integer({ minimum: 0 }),
  walletStatus: t.String(),
});

export const adminWalletResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    wallet: adminWalletDetailSchema,
  }),
});

export const adminWalletStatusHistoryEntrySchema = t.Object({
  id: t.String({ format: 'uuid' }),
  walletId: t.String({ format: 'uuid' }),
  fromStatus: t.Nullable(t.String()),
  toStatus: t.String(),
  reason: t.String(),
  actorUserId: t.Nullable(t.String()),
  actorAdminId: t.Nullable(t.String()),
  createdAt: t.String(),
});

export const adminWalletStatusHistoryResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    history: t.Array(adminWalletStatusHistoryEntrySchema),
  }),
});

export const adminWalletVerificationResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    matches: t.Boolean(),
    projected: walletBalanceSchema,
    ledger: walletBalanceSchema,
    activityCountMatches: t.Boolean(),
  }),
});

export type AdminWalletParams = Static<typeof adminWalletParamsSchema>;
export type AdminWalletStatusChangeInput = Static<typeof adminWalletStatusChangeSchema>;
export type AdminWalletStatusChangeHeaders = Static<typeof adminWalletStatusChangeHeadersSchema>;
export type AdminWalletResponse = Static<typeof adminWalletResponseSchema>;
export type AdminWalletStatusHistoryResponse = Static<typeof adminWalletStatusHistoryResponseSchema>;
export type AdminWalletVerificationResponse = Static<typeof adminWalletVerificationResponseSchema>;
export type AdminWalletListItem = Static<typeof adminWalletListItemSchema>;
export type AdminWalletListQuery = Static<typeof adminWalletListQuerySchema>;
export type AdminWalletListResponse = Static<typeof adminWalletListResponseSchema>;
export type AdminWalletFullDetailResponse = Static<typeof adminWalletFullDetailResponseSchema>;
