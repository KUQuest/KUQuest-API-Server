import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth.schema';

const time = (name: string) => timestamp(name, { withTimezone: true });
const id = () => uuid('id').defaultRandom().primaryKey();
const baht = (name: string) => bigint(name, { mode: 'bigint' });

export const wallets = pgTable('wallets', {
  id: id(), userId: text('user_id').notNull().unique().references(() => user.id),
  spendingBalanceBaht: baht('spending_balance_baht').default(sql`0`).notNull(), earningsBalanceBaht: baht('earnings_balance_baht').default(sql`0`).notNull(), heldForJobsBaht: baht('held_for_jobs_baht').default(sql`0`).notNull(), reservedForPayoutsBaht: baht('reserved_for_payouts_baht').default(sql`0`).notNull(),
  status: text('status').default('ACTIVE').notNull(), createdAt: time('created_at').defaultNow().notNull(), updatedAt: time('updated_at').defaultNow().notNull(),
}, (t) => [check('wallets_nonnegative_balances_chk', sql`${t.spendingBalanceBaht} >= 0 and ${t.earningsBalanceBaht} >= 0 and ${t.heldForJobsBaht} >= 0 and ${t.reservedForPayoutsBaht} >= 0`)]);

export const walletStatusHistory = pgTable('wallet_status_history', { id: id(), walletId: uuid('wallet_id').notNull().references(() => wallets.id), fromStatus: text('from_status'), toStatus: text('to_status').notNull(), actorUserId: text('actor_user_id').references(() => user.id), reason: text('reason'), occurredAt: time('occurred_at').defaultNow().notNull() }, (t) => [index('wallet_status_history_wallet_idx').on(t.walletId, t.occurredAt)]);

export const ledgerAccounts = pgTable('ledger_accounts', {
  id: id(), code: text('code').notNull().unique(), type: text('type').notNull(), currency: text('currency').default('THB').notNull(),
  walletId: uuid('wallet_id').references(() => wallets.id), userId: text('user_id').references(() => user.id), createdAt: time('created_at').defaultNow().notNull(),
}, (t) => [check('ledger_accounts_currency_chk', sql`${t.currency} = 'THB'`), check('ledger_accounts_owner_pair_chk', sql`(${t.walletId} is null) = (${t.userId} is null)`), uniqueIndex('ledger_accounts_wallet_type_uidx').on(t.walletId, t.type).where(sql`${t.walletId} is not null`)]);

export const idempotencyKeys = pgTable('idempotency_keys', {
  id: id(), principalUserId: text('principal_user_id').notNull().references(() => user.id), operationScope: text('operation_scope').notNull(), key: text('key').notNull(), requestHash: text('request_hash').notNull(),
  resourceType: text('resource_type'), resourceId: text('resource_id'), responseStatus: integer('response_status'), responseBody: jsonb('response_body'), createdAt: time('created_at').defaultNow().notNull(), expiresAt: time('expires_at').notNull(),
}, (t) => [unique('idempotency_keys_principal_scope_key_uq').on(t.principalUserId, t.operationScope, t.key), index('idempotency_keys_expiry_idx').on(t.expiresAt)]);

export const ledgerTransactions = pgTable('ledger_transactions', {
  id: id(), businessReference: text('business_reference').notNull().unique(), eventType: text('event_type').notNull(), idempotencyKeyId: uuid('idempotency_key_id').unique().references(() => idempotencyKeys.id),
  correctionOfTransactionId: uuid('correction_of_transaction_id'), createdByUserId: text('created_by_user_id').references(() => user.id), description: text('description'), createdAt: time('created_at').defaultNow().notNull(), sealedAt: time('sealed_at'),
});

export const ledgerPostings = pgTable('ledger_postings', {
  id: id(), transactionId: uuid('transaction_id').notNull().references(() => ledgerTransactions.id), accountId: uuid('account_id').notNull().references(() => ledgerAccounts.id), amountBaht: baht('amount_baht').notNull(), currency: text('currency').default('THB').notNull(), createdAt: time('created_at').defaultNow().notNull(),
}, (t) => [check('ledger_postings_nonzero_chk', sql`${t.amountBaht} <> 0`), check('ledger_postings_currency_chk', sql`${t.currency} = 'THB'`), index('ledger_postings_transaction_idx').on(t.transactionId), index('ledger_postings_account_idx').on(t.accountId, t.createdAt)]);

export const earningsConversions = pgTable('earnings_conversions', { id: id(), userId: text('user_id').notNull().references(() => user.id), amountBaht: baht('amount_baht').notNull(), ledgerTransactionId: uuid('ledger_transaction_id').notNull().unique().references(() => ledgerTransactions.id), createdAt: time('created_at').defaultNow().notNull() }, (t) => [check('earnings_conversions_amount_chk', sql`${t.amountBaht} > 0`)]);

export const walletActivities = pgTable('wallet_activities', { id: id(), userId: text('user_id').notNull().references(() => user.id), type: text('type').notNull(), status: text('status').notNull(), spendingDeltaBaht: baht('spending_delta_baht').default(sql`0`).notNull(), earningsDeltaBaht: baht('earnings_delta_baht').default(sql`0`).notNull(), jobHeldDeltaBaht: baht('job_held_delta_baht').default(sql`0`).notNull(), payoutReservedDeltaBaht: baht('payout_reserved_delta_baht').default(sql`0`).notNull(), resourceType: text('resource_type'), resourceId: text('resource_id'), occurredAt: time('occurred_at').defaultNow().notNull() }, (t) => [index('wallet_activities_user_time_idx').on(t.userId, t.occurredAt)]);

export const walletAdjustments = pgTable('wallet_adjustments', { id: id(), walletId: uuid('wallet_id').notNull().references(() => wallets.id), adminUserId: text('admin_user_id').notNull().references(() => user.id), compartment: text('compartment').notNull(), amountBaht: baht('amount_baht').notNull(), reason: text('reason').notNull(), ledgerTransactionId: uuid('ledger_transaction_id').notNull().unique().references(() => ledgerTransactions.id), createdAt: time('created_at').defaultNow().notNull() }, (t) => [check('wallet_adjustments_nonzero_chk', sql`${t.amountBaht} <> 0`)]);

export const amountsOwed = pgTable('amounts_owed', { id: id(), userId: text('user_id').notNull().references(() => user.id), amountBaht: baht('amount_baht').notNull(), recoveredBaht: baht('recovered_baht').default(sql`0`).notNull(), reason: text('reason').notNull(), sourceType: text('source_type').notNull(), sourceId: text('source_id'), status: text('status').notNull(), createdAt: time('created_at').defaultNow().notNull(), updatedAt: time('updated_at').defaultNow().notNull() }, (t) => [check('amounts_owed_range_chk', sql`${t.amountBaht} > 0 and ${t.recoveredBaht} >= 0 and ${t.recoveredBaht} <= ${t.amountBaht}`)]);
