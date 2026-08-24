import { relations, sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import { authAdmin, authUser } from './auth.schema';

export const walletStatuses = ['ACTIVE', 'FROZEN', 'SUSPENDED', 'CLOSED'] as const;
export type WalletStatus = (typeof walletStatuses)[number];

export const ledgerAccountTypes = [
  'SPENDING',
  'EARNINGS',
  'FUNDING_RESERVED',
  'RESERVED_FOR_PAYOUTS',
  'PLATFORM_REVENUE',
  'PLATFORM_SUSPENSE',
] as const;
export type LedgerAccountType = (typeof ledgerAccountTypes)[number];

export const ledgerEventTypes = [
  'TOP_UP',
  'PAYOUT',
  'FUNDING_RESERVE',
  'FUNDING_RELEASE',
  'ADJUSTMENT',
  'EARNINGS_CONVERSION',
] as const;
export type LedgerEventType = (typeof ledgerEventTypes)[number];

export const walletWallet = pgTable(
  'wallet_wallets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: text('user_id').notNull().unique().references(() => authUser.id),
    spendingBalanceSatang: integer('spending_balance_satang').default(0).notNull(),
    earningsBalanceSatang: integer('earnings_balance_satang').default(0).notNull(),
    fundingReservedSatang: integer('funding_reserved_satang').default(0).notNull(),
    reservedForPayoutsSatang: integer('reserved_for_payouts_satang').default(0).notNull(),
    walletStatus: text('wallet_status').$type<WalletStatus>().default('ACTIVE').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check('wallet_wallets_status_check', sql`${table.walletStatus} IN ('ACTIVE', 'FROZEN', 'SUSPENDED', 'CLOSED')`),
    check(
      'wallet_wallets_balances_check',
      sql`${table.spendingBalanceSatang} >= 0 AND ${table.earningsBalanceSatang} >= 0 AND ${table.fundingReservedSatang} >= 0 AND ${table.reservedForPayoutsSatang} >= 0`,
    ),
    check(
      'wallet_wallets_capacity_check',
      sql`${table.spendingBalanceSatang} + ${table.earningsBalanceSatang} + ${table.fundingReservedSatang} + ${table.reservedForPayoutsSatang} <= 2000000000`,
    ),
  ],
);

export const walletStatusHistory = pgTable(
  'wallet_status_history',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    walletId: uuid('wallet_id').notNull().references(() => walletWallet.id),
    fromStatus: text('from_status').$type<WalletStatus>(),
    toStatus: text('to_status').$type<WalletStatus>().notNull(),
    actorUserId: text('actor_user_id').references(() => authUser.id),
    actorAdminId: text('actor_admin_id').references(() => authAdmin.id),
    reason: text('reason'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('wallet_status_history_wallet_idx').on(table.walletId, table.occurredAt),
    uniqueIndex('wallet_status_history_initial_uidx')
      .on(table.walletId)
      .where(sql`${table.fromStatus} IS NULL`),
    check('wallet_status_history_from_check', sql`${table.fromStatus} IS NULL OR ${table.fromStatus} IN ('ACTIVE', 'FROZEN', 'SUSPENDED', 'CLOSED')`),
    check('wallet_status_history_to_check', sql`${table.toStatus} IN ('ACTIVE', 'FROZEN', 'SUSPENDED', 'CLOSED')`),
    check('wallet_status_history_actor_check', sql`num_nonnulls(${table.actorUserId}, ${table.actorAdminId}) <= 1`),
  ],
);

export const walletLedgerAccount = pgTable(
  'wallet_ledger_accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    code: text('code').notNull().unique(),
    type: text('type').$type<LedgerAccountType>().notNull(),
    walletId: uuid('wallet_id').references(() => walletWallet.id),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('wallet_ledger_accounts_wallet_type_uidx')
      .on(table.walletId, table.type)
      .where(sql`${table.walletId} IS NOT NULL`),
    check('wallet_ledger_accounts_type_check', sql`${table.type} IN ('SPENDING', 'EARNINGS', 'FUNDING_RESERVED', 'RESERVED_FOR_PAYOUTS', 'PLATFORM_REVENUE', 'PLATFORM_SUSPENSE')`),
    check('wallet_ledger_accounts_platform_check', sql`(${table.walletId} IS NULL) = (${table.type} IN ('PLATFORM_REVENUE', 'PLATFORM_SUSPENSE'))`),
  ],
);

export const walletIdempotencyKey = pgTable(
  'wallet_idempotency_keys',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    principalUserId: text('principal_user_id').notNull().references(() => authUser.id),
    operationScope: text('operation_scope').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    processingStatus: text('processing_status').default('PROCESSING').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('wallet_idempotency_keys_principal_scope_key').on(
      table.principalUserId,
      table.operationScope,
      table.key,
    ),
    index('wallet_idempotency_keys_expiry_idx').on(table.expiresAt),
    check('wallet_idempotency_keys_processing_status_check', sql`${table.processingStatus} IN ('PROCESSING', 'COMPLETED')`),
    check('wallet_idempotency_keys_completion_check', sql`(${table.processingStatus} = 'COMPLETED') = (${table.completedAt} IS NOT NULL)`),
  ],
);

export const walletLedgerTransaction = pgTable(
  'wallet_ledger_transactions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessReference: text('business_reference').notNull().unique(),
    eventType: text('event_type').$type<LedgerEventType>().notNull(),
    idempotencyKeyId: uuid('idempotency_key_id').unique().references(() => walletIdempotencyKey.id),
    correctionOfTransactionId: uuid('correction_of_transaction_id').references((): AnyPgColumn => walletLedgerTransaction.id),
    createdByUserId: text('created_by_user_id').references(() => authUser.id),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    sealedAt: timestamp('sealed_at', { withTimezone: true }),
  },
  (table) => [
    check('wallet_ledger_transactions_event_type_check', sql`${table.eventType} IN ('TOP_UP', 'PAYOUT', 'FUNDING_RESERVE', 'FUNDING_RELEASE', 'ADJUSTMENT', 'EARNINGS_CONVERSION')`),
  ],
);

export const walletLedgerPosting = pgTable(
  'wallet_ledger_postings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    transactionId: uuid('transaction_id').notNull().references(() => walletLedgerTransaction.id),
    accountId: uuid('account_id').notNull().references(() => walletLedgerAccount.id),
    amountSatang: integer('amount_satang').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('wallet_ledger_postings_transaction_idx').on(table.transactionId),
    index('wallet_ledger_postings_account_idx').on(table.accountId, table.createdAt),
    check(
      'wallet_ledger_postings_amount_check',
      sql`${table.amountSatang} <> 0 AND ${table.amountSatang} BETWEEN -2000000000 AND 2000000000`,
    ),
  ],
);

export const walletEarningsConversion = pgTable(
  'wallet_earnings_conversions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    principalUserId: text('principal_user_id').notNull().references(() => authUser.id),
    amountSatang: integer('amount_satang').notNull(),
    businessReference: text('business_reference').notNull().unique(),
    ledgerTransactionId: uuid('ledger_transaction_id').notNull().unique().references(() => walletLedgerTransaction.id),
    idempotencyKeyId: uuid('idempotency_key_id').notNull().unique().references(() => walletIdempotencyKey.id),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      'wallet_earnings_conversions_amount_check',
      sql`${table.amountSatang} > 0 AND ${table.amountSatang} <= 2000000000`,
    ),
  ],
);

export const paymentMoneyPolicyRevision = pgTable(
  'payment_money_policy_revisions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    revision: integer('revision').notNull().unique(),
    minimumTopUpSatang: integer('minimum_top_up_satang').notNull(),
    maximumTopUpSatang: integer('maximum_top_up_satang').notNull(),
    minimumFundingReservationSatang: integer('minimum_funding_reservation_satang').notNull(),
    maximumFundingReservationSatang: integer('maximum_funding_reservation_satang').notNull(),
    minimumEarningsConversionSatang: integer('minimum_earnings_conversion_satang').notNull(),
    maximumEarningsConversionSatang: integer('maximum_earnings_conversion_satang').notNull(),
    minimumPayoutSatang: integer('minimum_payout_satang').notNull(),
    maximumPayoutSatang: integer('maximum_payout_satang').notNull(),
    platformFeeBps: smallint('platform_fee_bps').notNull(),
    feeRoundingMode: text('fee_rounding_mode').default('UP').notNull(),
    topUpProviderFeeSatang: integer('top_up_provider_fee_satang').default(0).notNull(),
    topUpProviderTaxBps: smallint('top_up_provider_tax_bps').default(0).notNull(),
    payoutProviderFeeSatang: integer('payout_provider_fee_satang').default(0).notNull(),
    payoutProviderTaxBps: smallint('payout_provider_tax_bps').default(0).notNull(),
    quoteLifetimeSeconds: integer('quote_lifetime_seconds').notNull(),
    authoredByAdminId: text('authored_by_admin_id').references(() => authAdmin.id),
    reason: text('reason').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveUntil: timestamp('effective_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check('payment_money_policy_amounts_check', sql`${table.minimumTopUpSatang} > 0 AND ${table.maximumTopUpSatang} >= ${table.minimumTopUpSatang} AND ${table.minimumFundingReservationSatang} > 0 AND ${table.maximumFundingReservationSatang} >= ${table.minimumFundingReservationSatang} AND ${table.minimumEarningsConversionSatang} > 0 AND ${table.maximumEarningsConversionSatang} >= ${table.minimumEarningsConversionSatang} AND ${table.minimumPayoutSatang} > 0 AND ${table.maximumPayoutSatang} >= ${table.minimumPayoutSatang}`),
    check('payment_money_policy_rates_check', sql`${table.platformFeeBps} BETWEEN 0 AND 10000 AND ${table.topUpProviderFeeSatang} >= 0 AND ${table.topUpProviderTaxBps} BETWEEN 0 AND 10000 AND ${table.payoutProviderFeeSatang} >= 0 AND ${table.payoutProviderTaxBps} BETWEEN 0 AND 10000`),
    check('payment_money_policy_rounding_check', sql`${table.feeRoundingMode} = 'UP'`),
    check('payment_money_policy_windows_check', sql`${table.quoteLifetimeSeconds} > 0`),
    check('payment_money_policy_effective_check', sql`${table.effectiveUntil} IS NULL OR ${table.effectiveUntil} > ${table.effectiveFrom}`),
  ],
);

export const walletActivity = pgTable(
  'wallet_activities',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ledgerTransactionId: uuid('ledger_transaction_id').notNull().references(() => walletLedgerTransaction.id),
    userId: text('user_id').notNull().references(() => authUser.id),
    type: text('type').notNull(),
    activityStatus: text('activity_status').notNull(),
    spendingDeltaSatang: integer('spending_delta_satang').default(0).notNull(),
    earningsDeltaSatang: integer('earnings_delta_satang').default(0).notNull(),
    fundingReservedDeltaSatang: integer('funding_reserved_delta_satang').default(0).notNull(),
    payoutReservedDeltaSatang: integer('payout_reserved_delta_satang').default(0).notNull(),
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('wallet_activities_transaction_user_key').on(table.ledgerTransactionId, table.userId),
    index('wallet_activities_user_time_idx').on(table.userId, table.occurredAt),
    check('wallet_activities_type_check', sql`${table.type} IN ('TOP_UP', 'SPEND', 'EARN', 'HOLD', 'RELEASE', 'CONVERT')`),
    check('wallet_activities_status_check', sql`${table.activityStatus} IN ('PENDING', 'COMPLETED', 'FAILED')`),
  ],
);

export const walletWalletRelations = relations(walletWallet, ({ one, many }) => ({
  user: one(authUser, { fields: [walletWallet.userId], references: [authUser.id] }),
  statusHistory: many(walletStatusHistory),
  accounts: many(walletLedgerAccount),
}));

export const walletStatusHistoryRelations = relations(walletStatusHistory, ({ one }) => ({
  wallet: one(walletWallet, { fields: [walletStatusHistory.walletId], references: [walletWallet.id] }),
  actorUser: one(authUser, { fields: [walletStatusHistory.actorUserId], references: [authUser.id] }),
  actorAdmin: one(authAdmin, { fields: [walletStatusHistory.actorAdminId], references: [authAdmin.id] }),
}));

export const walletLedgerAccountRelations = relations(walletLedgerAccount, ({ one, many }) => ({
  wallet: one(walletWallet, { fields: [walletLedgerAccount.walletId], references: [walletWallet.id] }),
  postings: many(walletLedgerPosting),
}));

export const walletLedgerTransactionRelations = relations(walletLedgerTransaction, ({ one, many }) => ({
  idempotencyKey: one(walletIdempotencyKey, { fields: [walletLedgerTransaction.idempotencyKeyId], references: [walletIdempotencyKey.id] }),
  postings: many(walletLedgerPosting),
}));

export const walletLedgerPostingRelations = relations(walletLedgerPosting, ({ one }) => ({
  transaction: one(walletLedgerTransaction, { fields: [walletLedgerPosting.transactionId], references: [walletLedgerTransaction.id] }),
  account: one(walletLedgerAccount, { fields: [walletLedgerPosting.accountId], references: [walletLedgerAccount.id] }),
}));

export const walletEarningsConversionRelations = relations(walletEarningsConversion, ({ one }) => ({
  principal: one(authUser, { fields: [walletEarningsConversion.principalUserId], references: [authUser.id] }),
  ledgerTransaction: one(walletLedgerTransaction, { fields: [walletEarningsConversion.ledgerTransactionId], references: [walletLedgerTransaction.id] }),
  idempotencyKey: one(walletIdempotencyKey, { fields: [walletEarningsConversion.idempotencyKeyId], references: [walletIdempotencyKey.id] }),
}));
