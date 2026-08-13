import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { authAdmin, authUser } from './auth.schema';

const amount = (name: string) => bigint(name, { mode: 'bigint' });
const time = (name: string) => timestamp(name, { withTimezone: true });

export const walletWallets = pgTable(
  'wallet_wallets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull().unique().references(() => authUser.id),
    spendingBalanceBaht: amount('spending_balance_baht').default(sql`0`).notNull(),
    earningsBalanceBaht: amount('earnings_balance_baht').default(sql`0`).notNull(),
    heldForJobsBaht: amount('held_for_jobs_baht').default(sql`0`).notNull(),
    reservedForPayoutsBaht: amount('reserved_for_payouts_baht').default(sql`0`).notNull(),
    walletStatus: text('wallet_status').default('ACTIVE').notNull(),
    createdAt: time('created_at').defaultNow().notNull(),
    updatedAt: time('updated_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'wallet_wallets_balance_check',
      sql`${table.spendingBalanceBaht} >= 0 AND ${table.earningsBalanceBaht} >= 0 AND ${table.heldForJobsBaht} >= 0 AND ${table.reservedForPayoutsBaht} >= 0`,
    ),
    check(
      'wallet_wallets_status_check',
      sql`${table.walletStatus} IN ('ACTIVE', 'FROZEN', 'SUSPENDED', 'CLOSED')`,
    ),
  ],
);

export const walletStatusHistory = pgTable(
  'wallet_status_history',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    walletId: uuid('wallet_id').notNull().references(() => walletWallets.id),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    actorUserId: uuid('actor_user_id').references(() => authUser.id),
    actorAdminId: uuid('actor_admin_id').references(() => authAdmin.id),
    reason: text('reason'),
    occurredAt: time('occurred_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'wallet_status_history_from_status_check',
      sql`${table.fromStatus} IS NULL OR ${table.fromStatus} IN ('ACTIVE', 'FROZEN', 'SUSPENDED', 'CLOSED')`,
    ),
    check(
      'wallet_status_history_to_status_check',
      sql`${table.toStatus} IN ('ACTIVE', 'FROZEN', 'SUSPENDED', 'CLOSED')`,
    ),
    check(
      'wallet_status_history_actor_check',
      sql`num_nonnulls(${table.actorUserId}, ${table.actorAdminId}) <= 1`,
    ),
    index('wallet_status_history_wallet_idx').on(table.walletId, table.occurredAt),
  ],
);

export const walletLedgerAccounts = pgTable(
  'wallet_ledger_accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    code: text('code').notNull().unique(),
    type: text('type').notNull(),
    currency: text('currency').default('THB').notNull(),
    walletId: uuid('wallet_id').references(() => walletWallets.id),
    userId: uuid('user_id').references(() => authUser.id),
    createdAt: time('created_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'wallet_ledger_accounts_type_check',
      sql`${table.type} IN ('SPENDING', 'EARNINGS', 'HELD_FOR_JOBS', 'RESERVED_FOR_PAYOUTS', 'PLATFORM_REVENUE', 'PLATFORM_SUSPENSE')`,
    ),
    check('wallet_ledger_accounts_currency_check', sql`${table.currency} = 'THB'`),
    check(
      'wallet_ledger_accounts_owner_pair_check',
      sql`(${table.walletId} IS NULL) = (${table.userId} IS NULL)`,
    ),
    check(
      'wallet_ledger_accounts_platform_type_check',
      sql`(${table.walletId} IS NULL) = (${table.type} IN ('PLATFORM_REVENUE', 'PLATFORM_SUSPENSE'))`,
    ),
    uniqueIndex('wallet_ledger_accounts_wallet_type_uidx')
      .on(table.walletId, table.type)
      .where(sql`${table.walletId} IS NOT NULL`),
  ],
);

export const walletIdempotencyKeys = pgTable(
  'wallet_idempotency_keys',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    principalUserId: uuid('principal_user_id').notNull().references(() => authUser.id),
    operationScope: text('operation_scope').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt: time('created_at').defaultNow().notNull(),
    expiresAt: time('expires_at').notNull(),
  },
  (table) => [
    unique('wallet_idempotency_keys_principal_scope_key').on(
      table.principalUserId,
      table.operationScope,
      table.key,
    ),
    index('wallet_idempotency_keys_expiry_idx').on(table.expiresAt),
  ],
);

export const walletLedgerTransactions = pgTable(
  'wallet_ledger_transactions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessReference: text('business_reference').notNull().unique(),
    eventType: text('event_type').notNull(),
    idempotencyKeyId: uuid('idempotency_key_id')
      .unique()
      .references(() => walletIdempotencyKeys.id),
    correctionOfTransactionId: uuid('correction_of_transaction_id').references(
      (): AnyPgColumn => walletLedgerTransactions.id,
    ),
    createdByUserId: uuid('created_by_user_id').references(() => authUser.id),
    description: text('description'),
    createdAt: time('created_at').defaultNow().notNull(),
    sealedAt: time('sealed_at'),
  },
  (table) => [
    check(
      'wallet_ledger_transactions_event_type_check',
      sql`${table.eventType} IN ('TOP_UP', 'PAYOUT', 'ESCROW_HOLD', 'ESCROW_RELEASE', 'ADJUSTMENT', 'EARNINGS_CONVERSION')`,
    ),
  ],
);

export const walletLedgerPostings = pgTable(
  'wallet_ledger_postings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => walletLedgerTransactions.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => walletLedgerAccounts.id),
    amountBaht: amount('amount_baht').notNull(),
    currency: text('currency').default('THB').notNull(),
    createdAt: time('created_at').defaultNow().notNull(),
  },
  (table) => [
    check('wallet_ledger_postings_amount_check', sql`${table.amountBaht} <> 0`),
    check('wallet_ledger_postings_currency_check', sql`${table.currency} = 'THB'`),
    index('wallet_ledger_postings_transaction_idx').on(table.transactionId),
    index('wallet_ledger_postings_account_idx').on(table.accountId, table.createdAt),
  ],
);

export const walletEarningsConversions = pgTable(
  'wallet_earnings_conversions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull().references(() => authUser.id),
    amountBaht: amount('amount_baht').notNull(),
    ledgerTransactionId: uuid('ledger_transaction_id')
      .notNull()
      .unique()
      .references(() => walletLedgerTransactions.id),
    createdAt: time('created_at').defaultNow().notNull(),
  },
  (table) => [check('wallet_earnings_conversions_amount_check', sql`${table.amountBaht} > 0`)],
);

export const walletActivities = pgTable(
  'wallet_activities',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull().references(() => authUser.id),
    type: text('type').notNull(),
    activityStatus: text('activity_status').notNull(),
    spendingDeltaBaht: amount('spending_delta_baht').default(sql`0`).notNull(),
    earningsDeltaBaht: amount('earnings_delta_baht').default(sql`0`).notNull(),
    jobHeldDeltaBaht: amount('job_held_delta_baht').default(sql`0`).notNull(),
    payoutReservedDeltaBaht: amount('payout_reserved_delta_baht').default(sql`0`).notNull(),
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    occurredAt: time('occurred_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'wallet_activities_type_check',
      sql`${table.type} IN ('TOP_UP', 'SPEND', 'EARN', 'HOLD', 'RELEASE')`,
    ),
    check(
      'wallet_activities_status_check',
      sql`${table.activityStatus} IN ('PENDING', 'COMPLETED', 'FAILED')`,
    ),
    index('wallet_activities_user_time_idx').on(table.userId, table.occurredAt),
  ],
);

export const walletAdjustments = pgTable(
  'wallet_adjustments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    walletId: uuid('wallet_id').notNull().references(() => walletWallets.id),
    adminId: uuid('admin_id').notNull().references(() => authAdmin.id),
    compartment: text('compartment').notNull(),
    amountBaht: amount('amount_baht').notNull(),
    reason: text('reason').notNull(),
    ledgerTransactionId: uuid('ledger_transaction_id')
      .notNull()
      .unique()
      .references(() => walletLedgerTransactions.id),
    createdAt: time('created_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'wallet_adjustments_compartment_check',
      sql`${table.compartment} IN ('SPENDING', 'EARNINGS', 'HELD_FOR_JOBS', 'RESERVED_FOR_PAYOUTS')`,
    ),
    check('wallet_adjustments_amount_check', sql`${table.amountBaht} <> 0`),
  ],
);

export const walletAmountsOwed = pgTable(
  'wallet_amounts_owed',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull().references(() => authUser.id),
    amountBaht: amount('amount_baht').notNull(),
    recoveredBaht: amount('recovered_baht').default(sql`0`).notNull(),
    reason: text('reason').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id'),
    owedStatus: text('owed_status').notNull(),
    createdAt: time('created_at').defaultNow().notNull(),
    updatedAt: time('updated_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'wallet_amounts_owed_status_check',
      sql`${table.owedStatus} IN ('OUTSTANDING', 'RECOVERED', 'WRITTEN_OFF')`,
    ),
    check(
      'wallet_amounts_owed_range_check',
      sql`${table.amountBaht} > 0 AND ${table.recoveredBaht} >= 0 AND ${table.recoveredBaht} <= ${table.amountBaht}`,
    ),
  ],
);
