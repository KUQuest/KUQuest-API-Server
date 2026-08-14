import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { authAdmin, authUser } from './auth.schema';
import { walletLedgerTransaction } from './wallet.schema';

const amount = (name: string) => bigint(name, { mode: 'bigint' });
const time = (name: string) => timestamp(name, { withTimezone: true });

export const paymentMoneyPolicyRevisions = pgTable(
  'payment_money_policy_revisions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    revision: bigint('revision', { mode: 'bigint' }).notNull().unique(),
    minimumTopUpBaht: amount('minimum_top_up_baht').notNull(),
    maximumTopUpBaht: amount('maximum_top_up_baht').notNull(),
    minimumFundedJobBaht: amount('minimum_funded_job_baht').notNull(),
    maximumFundedJobBaht: amount('maximum_funded_job_baht').notNull(),
    minimumEarningsConversionBaht: amount('minimum_earnings_conversion_baht').notNull(),
    maximumEarningsConversionBaht: amount('maximum_earnings_conversion_baht').notNull(),
    minimumPayoutBaht: amount('minimum_payout_baht').notNull(),
    maximumPayoutBaht: amount('maximum_payout_baht').notNull(),
    platformFeeBps: smallint('platform_fee_bps').notNull(),
    topUpProviderFeeSatang: amount('top_up_provider_fee_satang').default(sql`0`).notNull(),
    topUpProviderTaxBps: smallint('top_up_provider_tax_bps').default(0).notNull(),
    payoutProviderFeeSatang: amount('payout_provider_fee_satang').default(sql`0`).notNull(),
    payoutProviderTaxBps: smallint('payout_provider_tax_bps').default(0).notNull(),
    disputeTwoPersonThresholdBaht: amount('dispute_two_person_threshold_baht').notNull(),
    quoteLifetimeSeconds: amount('quote_lifetime_seconds').notNull(),
    reviewWindowSeconds: amount('review_window_seconds').notNull(),
    defaultApplicationWindowSeconds: amount('default_application_window_seconds').notNull(),
    authoredByAdminId: uuid('authored_by_admin_id').references(() => authAdmin.id),
    reason: text('reason').notNull(),
    effectiveFrom: time('effective_from').notNull(),
    effectiveUntil: time('effective_until'),
    createdAt: time('created_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'payment_money_policy_revisions_amount_range_check',
      sql`${table.minimumTopUpBaht} > 0 AND ${table.maximumTopUpBaht} >= ${table.minimumTopUpBaht} AND ${table.minimumFundedJobBaht} > 0 AND ${table.maximumFundedJobBaht} >= ${table.minimumFundedJobBaht} AND ${table.minimumEarningsConversionBaht} > 0 AND ${table.maximumEarningsConversionBaht} >= ${table.minimumEarningsConversionBaht} AND ${table.minimumPayoutBaht} > 0 AND ${table.maximumPayoutBaht} >= ${table.minimumPayoutBaht}`,
    ),
    check(
      'payment_money_policy_revisions_fee_check',
      sql`${table.platformFeeBps} BETWEEN 0 AND 10000 AND ${table.topUpProviderFeeSatang} >= 0 AND ${table.topUpProviderTaxBps} BETWEEN 0 AND 10000 AND ${table.payoutProviderFeeSatang} >= 0 AND ${table.payoutProviderTaxBps} BETWEEN 0 AND 10000`,
    ),
    check(
      'payment_money_policy_revisions_duration_check',
      sql`${table.quoteLifetimeSeconds} > 0 AND ${table.reviewWindowSeconds} > 0 AND ${table.defaultApplicationWindowSeconds} > 0`,
    ),
    check(
      'payment_money_policy_revisions_effective_range_check',
      sql`${table.effectiveUntil} IS NULL OR ${table.effectiveUntil} > ${table.effectiveFrom}`,
    ),
  ],
);

export const paymentTopUpQuotes = pgTable(
  'payment_top_up_quotes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull().references(() => authUser.id),
    policyRevisionId: uuid('policy_revision_id')
      .notNull()
      .references(() => paymentMoneyPolicyRevisions.id),
    creditBaht: amount('credit_baht').notNull(),
    chargedFeeBaht: amount('charged_fee_baht').notNull(),
    chargedTaxBaht: amount('charged_tax_baht').notNull(),
    paymentTotalBaht: amount('payment_total_baht').notNull(),
    providerFeeSatang: amount('provider_fee_satang').notNull(),
    providerTaxSatang: amount('provider_tax_satang').notNull(),
    providerTotalSatang: amount('provider_total_satang').notNull(),
    currency: text('currency').default('THB').notNull(),
    expiresAt: time('expires_at').notNull(),
    consumedAt: time('consumed_at'),
    createdAt: time('created_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'payment_top_up_quotes_amount_check',
      sql`${table.creditBaht} > 0 AND ${table.chargedFeeBaht} >= 0 AND ${table.chargedTaxBaht} >= 0 AND ${table.paymentTotalBaht} = ${table.creditBaht} + ${table.chargedFeeBaht} + ${table.chargedTaxBaht} AND ${table.providerFeeSatang} >= 0 AND ${table.providerTaxSatang} >= 0 AND ${table.providerTotalSatang} > 0`,
    ),
    check('payment_top_up_quotes_currency_check', sql`${table.currency} = 'THB'`),
    index('payment_top_up_quotes_expiry_idx').on(table.expiresAt),
  ],
);

export const paymentTopUps = pgTable(
  'payment_top_ups',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    internalReference: text('internal_reference').notNull().unique(),
    userId: uuid('user_id').notNull().references(() => authUser.id),
    quoteId: uuid('quote_id').notNull().unique().references(() => paymentTopUpQuotes.id),
    provider: text('provider').notNull(),
    providerReference: text('provider_reference').unique(),
    creditBaht: amount('credit_baht').notNull(),
    chargedFeeBaht: amount('charged_fee_baht').notNull(),
    chargedTaxBaht: amount('charged_tax_baht').notNull(),
    paymentTotalBaht: amount('payment_total_baht').notNull(),
    providerFeeSatang: amount('provider_fee_satang').notNull(),
    providerTaxSatang: amount('provider_tax_satang').notNull(),
    providerTotalSatang: amount('provider_total_satang').notNull(),
    currency: text('currency').default('THB').notNull(),
    qrPayload: text('qr_payload'),
    qrExpiresAt: time('qr_expires_at'),
    topUpStatus: text('top_up_status').notNull(),
    creditedLedgerTransactionId: uuid('credited_ledger_transaction_id')
      .unique()
      .references(() => walletLedgerTransaction.id),
    createdAt: time('created_at').defaultNow().notNull(),
    updatedAt: time('updated_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'payment_top_ups_status_check',
      sql`${table.topUpStatus} IN ('PENDING', 'PAID', 'EXPIRED', 'FAILED')`,
    ),
    check(
      'payment_top_ups_amount_check',
      sql`${table.creditBaht} > 0 AND ${table.chargedFeeBaht} >= 0 AND ${table.chargedTaxBaht} >= 0 AND ${table.paymentTotalBaht} = ${table.creditBaht} + ${table.chargedFeeBaht} + ${table.chargedTaxBaht} AND ${table.providerFeeSatang} >= 0 AND ${table.providerTaxSatang} >= 0 AND ${table.providerTotalSatang} > 0`,
    ),
    check('payment_top_ups_currency_check', sql`${table.currency} = 'THB'`),
    index('payment_top_ups_user_status_idx').on(table.userId, table.topUpStatus),
  ],
);

export const paymentTopUpStatusHistory = pgTable(
  'payment_top_up_status_history',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    topUpId: uuid('top_up_id').notNull().references(() => paymentTopUps.id),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    providerStatus: text('provider_status'),
    actorUserId: uuid('actor_user_id').references(() => authUser.id),
    actorAdminId: uuid('actor_admin_id').references(() => authAdmin.id),
    source: text('source').notNull(),
    reason: text('reason'),
    occurredAt: time('occurred_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'payment_top_up_status_history_from_status_check',
      sql`${table.fromStatus} IS NULL OR ${table.fromStatus} IN ('PENDING', 'PAID', 'EXPIRED', 'FAILED')`,
    ),
    check(
      'payment_top_up_status_history_to_status_check',
      sql`${table.toStatus} IN ('PENDING', 'PAID', 'EXPIRED', 'FAILED')`,
    ),
    check(
      'payment_top_up_status_history_actor_check',
      sql`num_nonnulls(${table.actorUserId}, ${table.actorAdminId}) <= 1`,
    ),
    index('payment_top_up_status_history_idx').on(table.topUpId, table.occurredAt),
  ],
);

export const paymentPayoutAccounts = pgTable(
  'payment_payout_accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull().references(() => authUser.id),
    recipientType: text('recipient_type').notNull(),
    givenName: text('given_name').notNull(),
    surname: text('surname').notNull(),
    relationship: text('relationship').notNull(),
    accountCountry: text('account_country').default('TH').notNull(),
    accountCurrency: text('account_currency').default('THB').notNull(),
    bankCode: text('bank_code').notNull(),
    accountNumber: text('account_number').notNull(),
    accountHolderName: text('account_holder_name').notNull(),
    routingType: text('routing_type').notNull(),
    routingValue: text('routing_value').notNull(),
    maskedLastFour: text('masked_last_four').notNull(),
    createdAt: time('created_at').defaultNow().notNull(),
    retiredAt: time('retired_at'),
  },
  (table) => [
    check(
      'payment_payout_accounts_recipient_type_check',
      sql`${table.recipientType} IN ('SELF', 'THIRD_PARTY')`,
    ),
    check(
      'payment_payout_accounts_country_currency_check',
      sql`${table.accountCountry} = 'TH' AND ${table.accountCurrency} = 'THB'`,
    ),
    uniqueIndex('payment_payout_accounts_active_user_uidx')
      .on(table.userId)
      .where(sql`${table.retiredAt} IS NULL`),
  ],
);

export const paymentPayoutQuotes = pgTable(
  'payment_payout_quotes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull().references(() => authUser.id),
    payoutAccountId: uuid('payout_account_id')
      .notNull()
      .references(() => paymentPayoutAccounts.id),
    policyRevisionId: uuid('policy_revision_id')
      .notNull()
      .references(() => paymentMoneyPolicyRevisions.id),
    receiptBaht: amount('receipt_baht').notNull(),
    maximumFeeBaht: amount('maximum_fee_baht').notNull(),
    maximumTaxBaht: amount('maximum_tax_baht').notNull(),
    maximumDebitBaht: amount('maximum_debit_baht').notNull(),
    quotedFeeSatang: amount('quoted_fee_satang').notNull(),
    quotedTaxSatang: amount('quoted_tax_satang').notNull(),
    quotedDebitSatang: amount('quoted_debit_satang').notNull(),
    currency: text('currency').default('THB').notNull(),
    expiresAt: time('expires_at').notNull(),
    consumedAt: time('consumed_at'),
    createdAt: time('created_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'payment_payout_quotes_amount_check',
      sql`${table.receiptBaht} > 0 AND ${table.maximumFeeBaht} >= 0 AND ${table.maximumTaxBaht} >= 0 AND ${table.maximumDebitBaht} = ${table.receiptBaht} + ${table.maximumFeeBaht} + ${table.maximumTaxBaht} AND ${table.quotedFeeSatang} >= 0 AND ${table.quotedTaxSatang} >= 0 AND ${table.quotedDebitSatang} > 0`,
    ),
    check('payment_payout_quotes_currency_check', sql`${table.currency} = 'THB'`),
    index('payment_payout_quotes_expiry_idx').on(table.expiresAt),
  ],
);

export const paymentPayouts = pgTable(
  'payment_payouts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').notNull().references(() => authUser.id),
    quoteId: uuid('quote_id').notNull().unique().references(() => paymentPayoutQuotes.id),
    payoutAccountId: uuid('payout_account_id')
      .notNull()
      .references(() => paymentPayoutAccounts.id),
    destinationRecipientType: text('destination_recipient_type').notNull(),
    destinationGivenName: text('destination_given_name').notNull(),
    destinationSurname: text('destination_surname').notNull(),
    destinationRelationship: text('destination_relationship').notNull(),
    destinationAccountCountry: text('destination_account_country').notNull(),
    destinationAccountCurrency: text('destination_account_currency').notNull(),
    destinationBankCode: text('destination_bank_code').notNull(),
    destinationAccountNumber: text('destination_account_number').notNull(),
    destinationAccountHolderName: text('destination_account_holder_name').notNull(),
    destinationRoutingType: text('destination_routing_type').notNull(),
    destinationRoutingValue: text('destination_routing_value').notNull(),
    provider: text('provider').notNull(),
    providerReference: text('provider_reference').unique(),
    principalBaht: amount('principal_baht').notNull(),
    maximumFeeBaht: amount('maximum_fee_baht').notNull(),
    maximumTaxBaht: amount('maximum_tax_baht').notNull(),
    maximumDebitBaht: amount('maximum_debit_baht').notNull(),
    actualFeeSatang: amount('actual_fee_satang'),
    actualTaxSatang: amount('actual_tax_satang'),
    actualDebitSatang: amount('actual_debit_satang'),
    currency: text('currency').default('THB').notNull(),
    payoutStatus: text('payout_status').notNull(),
    reserveLedgerTransactionId: uuid('reserve_ledger_transaction_id')
      .notNull()
      .unique()
      .references(() => walletLedgerTransaction.id),
    finalLedgerTransactionId: uuid('final_ledger_transaction_id')
      .unique()
      .references(() => walletLedgerTransaction.id),
    createdAt: time('created_at').defaultNow().notNull(),
    updatedAt: time('updated_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'payment_payouts_status_check',
      sql`${table.payoutStatus} IN ('CREATING', 'PENDING', 'AWAITING_RECONCILIATION', 'COMPLETED', 'FAILED', 'CANCELLED')`,
    ),
    check(
      'payment_payouts_amount_check',
      sql`${table.principalBaht} > 0 AND ${table.maximumFeeBaht} >= 0 AND ${table.maximumTaxBaht} >= 0 AND ${table.maximumDebitBaht} = ${table.principalBaht} + ${table.maximumFeeBaht} + ${table.maximumTaxBaht}`,
    ),
    check(
      'payment_payouts_currency_check',
      sql`${table.currency} = 'THB' AND ${table.destinationAccountCountry} = 'TH' AND ${table.destinationAccountCurrency} = 'THB'`,
    ),
    uniqueIndex('payment_payouts_active_user_uidx')
      .on(table.userId)
      .where(sql`${table.payoutStatus} IN ('CREATING', 'PENDING', 'AWAITING_RECONCILIATION')`),
  ],
);

export const paymentPayoutStatusHistory = pgTable(
  'payment_payout_status_history',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    payoutId: uuid('payout_id').notNull().references(() => paymentPayouts.id),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    providerStatus: text('provider_status'),
    actorUserId: uuid('actor_user_id').references(() => authUser.id),
    actorAdminId: uuid('actor_admin_id').references(() => authAdmin.id),
    source: text('source').notNull(),
    reason: text('reason'),
    occurredAt: time('occurred_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'payment_payout_status_history_from_status_check',
      sql`${table.fromStatus} IS NULL OR ${table.fromStatus} IN ('CREATING', 'PENDING', 'AWAITING_RECONCILIATION', 'COMPLETED', 'FAILED', 'CANCELLED')`,
    ),
    check(
      'payment_payout_status_history_to_status_check',
      sql`${table.toStatus} IN ('CREATING', 'PENDING', 'AWAITING_RECONCILIATION', 'COMPLETED', 'FAILED', 'CANCELLED')`,
    ),
    check(
      'payment_payout_status_history_actor_check',
      sql`num_nonnulls(${table.actorUserId}, ${table.actorAdminId}) <= 1`,
    ),
    index('payment_payout_status_history_idx').on(table.payoutId, table.occurredAt),
  ],
);

export const paymentPayoutCancellationAttempts = pgTable(
  'payment_payout_cancellation_attempts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    payoutId: uuid('payout_id').notNull().references(() => paymentPayouts.id),
    adminId: uuid('admin_id').notNull().references(() => authAdmin.id),
    reason: text('reason').notNull(),
    attemptStatus: text('attempt_status').notNull(),
    providerResponse: jsonb('provider_response'),
    attemptedAt: time('attempted_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'payment_payout_cancellation_attempts_status_check',
      sql`${table.attemptStatus} IN ('PENDING', 'SUCCEEDED', 'FAILED')`,
    ),
    index('payment_payout_cancellation_attempts_payout_idx').on(
      table.payoutId,
      table.attemptedAt,
    ),
  ],
);
