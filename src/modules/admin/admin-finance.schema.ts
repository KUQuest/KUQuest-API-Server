import { t, type Static } from 'elysia';

const dateTime = t.String({ format: 'date-time' });
const uuid = t.String({ format: 'uuid' });

export const adminQuestFinanceParamsSchema = t.Object({
  questId: uuid,
});

export const adminQuestFinanceResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    quest: t.Object({
      id: uuid,
      title: t.String(),
      questStatus: t.String(),
      headcount: t.Integer({ minimum: 1 }),
      rewardSatang: t.Union([t.Integer({ minimum: 0 }), t.Null()]),
      platformFeePerWorkerSatang: t.Union([t.Integer({ minimum: 0 }), t.Null()]),
      questFundingTotalSatang: t.Union([t.Integer({ minimum: 0 }), t.Null()]),
      hirer: t.Object({
        id: uuid,
        firstName: t.String(),
        lastName: t.String(),
        studentId: t.Union([t.String(), t.Null()]),
      }),
    }),
    reservation: t.Union([
      t.Object({
        id: uuid,
        status: t.String(),
        totalReservedSatang: t.Integer({ minimum: 0 }),
        remainingSatang: t.Integer({ minimum: 0 }),
        createdAt: dateTime,
      }),
      t.Null(),
    ]),
    transfers: t.Array(
      t.Object({
        id: t.String(),
        occurredAt: dateTime,
        type: t.Union([
          t.Literal('RESERVE'),
          t.Literal('SETTLEMENT'),
          t.Literal('RELEASE'),
          t.Literal('DISPUTE_SETTLEMENT'),
        ]),
        from: t.Object({
          type: t.String(),
          id: t.String(),
          displayName: t.String(),
        }),
        to: t.Object({
          type: t.String(),
          id: t.String(),
          displayName: t.String(),
        }),
        amountSatang: t.Integer(),
        platformFeeSatang: t.Integer({ minimum: 0 }),
        description: t.String(),
        ledgerTransactionId: uuid,
        businessReference: t.String(),
      }),
    ),
    ledgerTransactions: t.Array(
      t.Object({
        id: uuid,
        businessReference: t.String(),
        eventType: t.String(),
        description: t.Union([t.String(), t.Null()]),
        createdAt: dateTime,
        sealedAt: t.Union([dateTime, t.Null()]),
        postings: t.Array(
          t.Object({
            id: uuid,
            accountId: uuid,
            accountType: t.String(),
            walletId: t.Union([uuid, t.Null()]),
            ownerUserId: t.Union([uuid, t.Null()]),
            amountSatang: t.Integer(),
          }),
        ),
      }),
    ),
  }),
});

export const adminLedgerTransactionsQuerySchema = t.Object({
  eventType: t.Optional(
    t.Union([
      t.Literal('TOP_UP'),
      t.Literal('PAYOUT'),
      t.Literal('FUNDING_RESERVE'),
      t.Literal('FUNDING_RELEASE'),
      t.Literal('FUNDING_SETTLEMENT'),
      t.Literal('ADJUSTMENT'),
      t.Literal('EARNINGS_CONVERSION'),
    ]),
  ),
  userId: t.Optional(uuid),
  walletId: t.Optional(uuid),
  businessReference: t.Optional(t.String()),
  from: t.Optional(dateTime),
  to: t.Optional(dateTime),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
  cursor: t.Optional(t.String()),
});

export const adminLedgerTransactionsResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    items: t.Array(
      t.Object({
        id: uuid,
        businessReference: t.String(),
        eventType: t.String(),
        description: t.Union([t.String(), t.Null()]),
        createdByUserId: t.Union([uuid, t.Null()]),
        correctionOfTransactionId: t.Union([uuid, t.Null()]),
        createdAt: dateTime,
        sealedAt: t.Union([dateTime, t.Null()]),
        isBalanced: t.Boolean(),
        postings: t.Array(
          t.Object({
            id: uuid,
            accountId: uuid,
            accountType: t.String(),
            walletId: t.Union([uuid, t.Null()]),
            amountSatang: t.Integer(),
            member: t.Union([
              t.Object({
                userId: uuid,
                firstName: t.String(),
                lastName: t.String(),
                studentId: t.Union([t.String(), t.Null()]),
              }),
              t.Null(),
            ]),
          }),
        ),
      }),
    ),
    nextCursor: t.Union([t.String(), t.Null()]),
  }),
});

export const adminFinanceOverviewResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    platformBalances: t.Object({
      revenueSatang: t.Integer(),
      suspenseSatang: t.Integer(),
    }),
    memberBalancesSummary: t.Object({
      totalSpendingSatang: t.Integer(),
      totalEarningsSatang: t.Integer(),
      totalFundingReservedSatang: t.Integer(),
      totalPayoutReservedSatang: t.Integer(),
      totalCirculatingSatang: t.Integer(),
    }),
    volumeLifetime: t.Object({
      totalTopUpDepositedSatang: t.Integer(),
      totalPayoutCompletedSatang: t.Integer(),
      totalPlatformFeesEarnedSatang: t.Integer(),
    }),
    integrity: t.Object({
      subledgerBalanced: t.Boolean(),
      totalPostingsDiscrepancySatang: t.Integer(),
      lastAuditedAt: dateTime,
    }),
  }),
});

export const adminMemberFinanceParamsSchema = t.Object({
  userId: uuid,
});

export const adminMemberFinanceResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    member: t.Object({
      userId: uuid,
      firstName: t.String(),
      lastName: t.String(),
      studentId: t.Union([t.String(), t.Null()]),
      email: t.String(),
    }),
    wallet: t.Union([
      t.Object({
        id: uuid,
        walletStatus: t.String(),
        spendingBalanceSatang: t.Integer(),
        earningsBalanceSatang: t.Integer(),
        fundingReservedSatang: t.Integer(),
        reservedForPayoutsSatang: t.Integer(),
        projectionMatchesLedger: t.Boolean(),
      }),
      t.Null(),
    ]),
    lifetimeStats: t.Object({
      totalToppedUpSatang: t.Integer(),
      totalEarnedFromQuestsSatang: t.Integer(),
      totalSpentOnQuestsSatang: t.Integer(),
      totalPaidOutSatang: t.Integer(),
      totalEarningsConvertedSatang: t.Integer(),
    }),
    activeFundingReservations: t.Array(
      t.Object({
        id: uuid,
        callerReference: t.String(),
        totalReservedSatang: t.Integer(),
        remainingSatang: t.Integer(),
        createdAt: dateTime,
      }),
    ),
  }),
});

export const adminMoneyPolicyItemSchema = t.Object({
  id: uuid,
  revision: t.Integer({ minimum: 1 }),
  minimumTopUpSatang: t.Integer({ minimum: 1 }),
  maximumTopUpSatang: t.Integer({ minimum: 1 }),
  minimumFundingReservationSatang: t.Integer({ minimum: 1 }),
  maximumFundingReservationSatang: t.Integer({ minimum: 1 }),
  minimumEarningsConversionSatang: t.Integer({ minimum: 1 }),
  maximumEarningsConversionSatang: t.Integer({ minimum: 1 }),
  minimumPayoutSatang: t.Integer({ minimum: 1 }),
  maximumPayoutSatang: t.Integer({ minimum: 1 }),
  platformFeeBps: t.Integer({ minimum: 0, maximum: 10000 }),
  feeRoundingMode: t.String(),
  topUpProviderFeeSatang: t.Integer({ minimum: 0 }),
  topUpProviderTaxBps: t.Integer({ minimum: 0 }),
  payoutProviderFeeSatang: t.Integer({ minimum: 0 }),
  payoutProviderTaxBps: t.Integer({ minimum: 0 }),
  quoteLifetimeSeconds: t.Integer({ minimum: 1 }),
  reason: t.String(),
  effectiveFrom: dateTime,
  effectiveUntil: t.Union([dateTime, t.Null()]),
  authoredByAdminId: t.Union([uuid, t.Null()]),
  createdAt: dateTime,
});

export const adminMoneyPolicyCurrentResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    policy: t.Union([adminMoneyPolicyItemSchema, t.Null()]),
  }),
});

export const adminMoneyPolicyListResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    policies: t.Array(adminMoneyPolicyItemSchema),
  }),
});

export type AdminMoneyPolicyItem = Static<typeof adminMoneyPolicyItemSchema>;

export type AdminQuestFinanceParams = Static<typeof adminQuestFinanceParamsSchema>;
export type AdminQuestFinanceData = Static<typeof adminQuestFinanceResponseSchema>['data'];
export type AdminLedgerTransactionsQuery = Static<typeof adminLedgerTransactionsQuerySchema>;
export type AdminLedgerTransactionsData = Static<typeof adminLedgerTransactionsResponseSchema>['data'];
export type AdminFinanceOverviewData = Static<typeof adminFinanceOverviewResponseSchema>['data'];
export type AdminMemberFinanceParams = Static<typeof adminMemberFinanceParamsSchema>;
export type AdminMemberFinanceData = Static<typeof adminMemberFinanceResponseSchema>['data'];
