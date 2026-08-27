import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { authAdmin, authUser } from './auth.schema';
import { paymentMoneyPolicyRevision, walletLedgerTransaction } from './wallet.schema';

const time = (name: string) => timestamp(name, { withTimezone: true });

export { paymentMoneyPolicyRevision };
export const paymentMoneyPolicyRevisions = paymentMoneyPolicyRevision;

export const topUpStatuses = ['PENDING', 'PAID', 'EXPIRED', 'FAILED'] as const;
export type TopUpStatus = (typeof topUpStatuses)[number];

export const providerEventProcessingStatuses = [
  'RECEIVED',
  'PROCESSING',
  'RETRYABLE',
  'PROCESSED',
  'DEAD_LETTER',
] as const;
export type ProviderEventProcessingStatus = (typeof providerEventProcessingStatuses)[number];

export const payoutStatuses = [
  'CREATING',
  'PENDING',
  'AWAITING_RECONCILIATION',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type PayoutStatus = (typeof payoutStatuses)[number];

export const paymentTopUpQuote = pgTable(
  'payment_top_up_quotes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    feeRoundingMode: text('fee_rounding_mode').default('UP').notNull(),
    userId: text('user_id').notNull().references(() => authUser.id),
    policyRevisionId: uuid('policy_revision_id')
      .notNull()
      .references(() => paymentMoneyPolicyRevision.id),
    creditSatang: integer('credit_satang').notNull(),
    chargedFeeSatang: integer('charged_fee_satang').notNull(),
    chargedTaxSatang: integer('charged_tax_satang').notNull(),
    paymentTotalSatang: integer('payment_total_satang').notNull(),
    providerFeeSatang: integer('provider_fee_satang').notNull(),
    providerTaxSatang: integer('provider_tax_satang').notNull(),
    providerTotalSatang: integer('provider_total_satang').notNull(),
    expiresAt: time('expires_at').notNull(),
    consumedAt: time('consumed_at'),
    createdAt: time('created_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'payment_top_up_quotes_amount_check',
      sql`${table.creditSatang} > 0 AND ${table.chargedFeeSatang} >= 0 AND ${table.chargedTaxSatang} >= 0 AND ${table.paymentTotalSatang} = ${table.creditSatang} + ${table.chargedFeeSatang} + ${table.chargedTaxSatang} AND ${table.providerFeeSatang} >= 0 AND ${table.providerTaxSatang} >= 0 AND ${table.providerTotalSatang} = ${table.creditSatang} + ${table.providerFeeSatang} + ${table.providerTaxSatang}`,
    ),
    check('payment_top_up_quotes_rounding_check', sql`${table.feeRoundingMode} = 'UP'`),
    unique('payment_top_up_quotes_id_user_key').on(table.id, table.userId),
    index('payment_top_up_quotes_expiry_idx').on(table.expiresAt),
  ],
);

export const paymentTopUp = pgTable(
  'payment_top_ups',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    internalReference: text('internal_reference').notNull().unique(),
    userId: text('user_id').notNull().references(() => authUser.id),
    quoteId: uuid('quote_id').notNull().unique().references(() => paymentTopUpQuote.id),
    provider: text('provider').notNull(),
    providerReference: text('provider_reference').unique(),
    providerApiVersion: text('provider_api_version'),
    providerStatus: text('provider_status'),
    providerAmountSatang: integer('provider_amount_satang'),
    providerChannelCode: text('provider_channel_code'),
    creditSatang: integer('credit_satang').notNull(),
    chargedFeeSatang: integer('charged_fee_satang').notNull(),
    chargedTaxSatang: integer('charged_tax_satang').notNull(),
    paymentTotalSatang: integer('payment_total_satang').notNull(),
    providerFeeSatang: integer('provider_fee_satang').notNull(),
    providerTaxSatang: integer('provider_tax_satang').notNull(),
    providerTotalSatang: integer('provider_total_satang').notNull(),
    qrPayload: text('qr_payload'),
    qrExpiresAt: time('qr_expires_at'),
    topUpStatus: text('top_up_status').$type<TopUpStatus>().notNull(),
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
      sql`${table.creditSatang} > 0 AND ${table.chargedFeeSatang} >= 0 AND ${table.chargedTaxSatang} >= 0 AND ${table.paymentTotalSatang} = ${table.creditSatang} + ${table.chargedFeeSatang} + ${table.chargedTaxSatang} AND ${table.providerFeeSatang} >= 0 AND ${table.providerTaxSatang} >= 0 AND ${table.providerTotalSatang} = ${table.creditSatang} + ${table.providerFeeSatang} + ${table.providerTaxSatang} AND (${table.providerAmountSatang} IS NULL OR ${table.providerAmountSatang} = ${table.paymentTotalSatang})`,
    ),
    unique('payment_top_ups_id_user_key').on(table.id, table.userId),
    foreignKey({
      columns: [table.quoteId, table.userId],
      foreignColumns: [paymentTopUpQuote.id, paymentTopUpQuote.userId],
      name: 'payment_top_ups_quote_user_fk',
    }),
    index('payment_top_ups_user_status_idx').on(table.userId, table.topUpStatus),
  ],
);

export const paymentTopUpStatusHistory = pgTable(
  'payment_top_up_status_history',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    topUpId: uuid('top_up_id').notNull().references(() => paymentTopUp.id),
    fromStatus: text('from_status').$type<TopUpStatus>(),
    toStatus: text('to_status').$type<TopUpStatus>().notNull(),
    providerStatus: text('provider_status'),
    actorUserId: text('actor_user_id').references(() => authUser.id),
    actorAdminId: text('actor_admin_id').references(() => authAdmin.id),
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

export const paymentProviderEventInbox = pgTable(
  'payment_provider_event_inbox',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    eventType: text('event_type').notNull(),
    resourceType: text('resource_type').notNull(),
    internalReference: text('internal_reference'),
    providerReference: text('provider_reference'),
    providerApiVersion: text('provider_api_version'),
    providerStatus: text('provider_status').notNull(),
    normalizedStatus: text('normalized_status').notNull(),
    providerAmountSatang: integer('provider_amount_satang'),
    providerActualFeeSatang: integer('provider_actual_fee_satang'),
    providerActualTaxSatang: integer('provider_actual_tax_satang'),
    providerActualDebitSatang: integer('provider_actual_debit_satang'),
    providerChannelCode: text('provider_channel_code'),
    providerOccurredAt: time('provider_occurred_at').notNull(),
    payloadHash: text('payload_hash').notNull(),
    rawPayloadKeyVersion: text('raw_payload_key_version'),
    rawPayloadNonce: text('raw_payload_nonce'),
    rawPayloadCiphertext: text('raw_payload_ciphertext'),
    rawPayloadAuthTag: text('raw_payload_auth_tag'),
    rawPayloadExpiresAt: time('raw_payload_expires_at').notNull(),
    processingStatus: text('processing_status')
      .$type<ProviderEventProcessingStatus>()
      .default('RECEIVED')
      .notNull(),
    attemptCount: smallint('attempt_count').default(0).notNull(),
    claimedAt: time('claimed_at'),
    processedAt: time('processed_at'),
    lastError: text('last_error'),
    receivedAt: time('received_at').defaultNow().notNull(),
    createdAt: time('created_at').defaultNow().notNull(),
  },
  (table) => [
    unique('payment_provider_event_inbox_provider_event_key').on(
      table.provider,
      table.providerEventId,
    ),
    index('payment_provider_event_inbox_processing_idx').on(
      table.processingStatus,
      table.receivedAt,
    ),
    index('payment_provider_event_inbox_expiry_idx').on(table.rawPayloadExpiresAt),
    check(
      'payment_provider_event_inbox_amount_check',
      sql`${table.providerAmountSatang} IS NULL OR ${table.providerAmountSatang} > 0`,
    ),
    check(
      'payment_provider_event_inbox_attempt_check',
      sql`${table.attemptCount} BETWEEN 0 AND 5`,
    ),
    check(
      'payment_provider_event_inbox_normalized_status_check',
      sql`${table.normalizedStatus} IN ('PENDING', 'PAID', 'EXPIRED', 'FAILED', 'COMPLETED', 'CANCELLED')`,
    ),
    check(
      'payment_provider_event_inbox_actual_amount_check',
      sql`num_nonnulls(${table.providerActualFeeSatang}, ${table.providerActualTaxSatang}, ${table.providerActualDebitSatang}) IN (0, 3) AND (${table.providerActualFeeSatang} IS NULL OR (${table.providerActualFeeSatang} >= 0 AND ${table.providerActualTaxSatang} >= 0 AND ${table.providerActualDebitSatang} = ${table.providerAmountSatang} + ${table.providerActualFeeSatang} + ${table.providerActualTaxSatang}))`,
    ),
    check(
      'payment_provider_event_inbox_processing_status_check',
      sql`${table.processingStatus} IN ('RECEIVED', 'PROCESSING', 'RETRYABLE', 'PROCESSED', 'DEAD_LETTER')`,
    ),
    check(
      'payment_provider_event_inbox_raw_payload_check',
      sql`num_nonnulls(${table.rawPayloadKeyVersion}, ${table.rawPayloadNonce}, ${table.rawPayloadCiphertext}, ${table.rawPayloadAuthTag}) IN (0, 4)`,
    ),
  ],
);

export const paymentProviderEventHistory = pgTable(
  'payment_provider_event_history',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id').notNull().references(() => paymentProviderEventInbox.id),
    fromStatus: text('from_status').$type<ProviderEventProcessingStatus>(),
    toStatus: text('to_status').$type<ProviderEventProcessingStatus>().notNull(),
    source: text('source').notNull(),
    reason: text('reason'),
    error: text('error'),
    occurredAt: time('occurred_at').defaultNow().notNull(),
  },
  (table) => [
    index('payment_provider_event_history_event_idx').on(table.eventId, table.occurredAt),
    check(
      'payment_provider_event_history_from_status_check',
      sql`${table.fromStatus} IS NULL OR ${table.fromStatus} IN ('RECEIVED', 'PROCESSING', 'RETRYABLE', 'PROCESSED', 'DEAD_LETTER')`,
    ),
    check(
      'payment_provider_event_history_to_status_check',
      sql`${table.toStatus} IN ('RECEIVED', 'PROCESSING', 'RETRYABLE', 'PROCESSED', 'DEAD_LETTER')`,
    ),
  ],
);

export const paymentProviderEvents = paymentProviderEventInbox;
export const paymentProviderEventStatusHistory = paymentProviderEventHistory;

export const paymentTopUpQuotes = paymentTopUpQuote;
export const paymentTopUps = paymentTopUp;

export const paymentPayoutAccounts = pgTable(
  'payment_payout_accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: text('user_id').notNull().references(() => authUser.id),
    recipientType: text('recipient_type').notNull(),
    givenName: text('given_name').notNull(),
    surname: text('surname').notNull(),
    relationship: text('relationship').notNull(),
    accountCountry: text('account_country').default('TH').notNull(),
    accountCurrency: text('account_currency').default('THB').notNull(),
    bankCode: text('bank_code').notNull(),
    accountNumberKeyVersion: text('account_number_key_version').notNull(),
    accountNumberNonce: text('account_number_nonce').notNull(),
    accountNumberCiphertext: text('account_number_ciphertext').notNull(),
    accountNumberAuthTag: text('account_number_auth_tag').notNull(),
    accountHolderName: text('account_holder_name').notNull(),
    routingType: text('routing_type').notNull(),
    routingValueKeyVersion: text('routing_value_key_version').notNull(),
    routingValueNonce: text('routing_value_nonce').notNull(),
    routingValueCiphertext: text('routing_value_ciphertext').notNull(),
    routingValueAuthTag: text('routing_value_auth_tag').notNull(),
    maskedLastFour: text('masked_last_four').notNull(),
    maskedRoutingValue: text('masked_routing_value').notNull().default('****'),
    createdAt: time('created_at').defaultNow().notNull(),
    retiredAt: time('retired_at'),
  },
  (table) => [
    check(
      'payment_payout_accounts_recipient_type_check',
      sql`${table.recipientType} = 'SELF'`,
    ),
    check(
      'payment_payout_accounts_routing_type_check',
      sql`${table.routingType} IN ('BANK_ACCOUNT', 'PROMPTPAY')`,
    ),
    check(
      'payment_payout_accounts_country_currency_check',
      sql`${table.accountCountry} = 'TH' AND ${table.accountCurrency} = 'THB'`,
    ),
    uniqueIndex('payment_payout_accounts_active_user_uidx')
      .on(table.userId)
      .where(sql`${table.retiredAt} IS NULL`),
    unique('payment_payout_accounts_id_user_key').on(table.id, table.userId),
  ],
);

export const paymentPayoutQuotes = pgTable(
  'payment_payout_quotes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    feeRoundingMode: text('fee_rounding_mode').default('UP').notNull(),
    userId: text('user_id').notNull().references(() => authUser.id),
    payoutAccountId: uuid('payout_account_id')
      .notNull()
      .references(() => paymentPayoutAccounts.id),
    policyRevisionId: uuid('policy_revision_id')
      .notNull()
      .references(() => paymentMoneyPolicyRevisions.id),
    receiptSatang: integer('receipt_satang').notNull(),
    maximumFeeSatang: integer('maximum_fee_satang').notNull(),
    maximumTaxSatang: integer('maximum_tax_satang').notNull(),
    maximumDebitSatang: integer('maximum_debit_satang').notNull(),
    expiresAt: time('expires_at').notNull(),
    consumedAt: time('consumed_at'),
    createdAt: time('created_at').defaultNow().notNull(),
  },
  (table) => [
    check(
      'payment_payout_quotes_amount_check',
      sql`${table.receiptSatang} > 0 AND ${table.maximumFeeSatang} >= 0 AND ${table.maximumTaxSatang} >= 0 AND ${table.maximumDebitSatang} = ${table.receiptSatang} + ${table.maximumFeeSatang} + ${table.maximumTaxSatang}`,
    ),
    check('payment_payout_quotes_rounding_check', sql`${table.feeRoundingMode} = 'UP'`),
    unique('payment_payout_quotes_id_user_key').on(table.id, table.userId),
    foreignKey({
      columns: [table.payoutAccountId, table.userId],
      foreignColumns: [paymentPayoutAccounts.id, paymentPayoutAccounts.userId],
      name: 'payment_payout_quotes_account_user_fk',
    }),
    index('payment_payout_quotes_expiry_idx').on(table.expiresAt),
  ],
);

export const paymentPayouts = pgTable(
  'payment_payouts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    internalReference: text('internal_reference').notNull().unique(),
    userId: text('user_id').notNull().references(() => authUser.id),
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
    destinationAccountNumberKeyVersion: text('destination_account_number_key_version').notNull(),
    destinationAccountNumberNonce: text('destination_account_number_nonce').notNull(),
    destinationAccountNumberCiphertext: text('destination_account_number_ciphertext').notNull(),
    destinationAccountNumberAuthTag: text('destination_account_number_auth_tag').notNull(),
    destinationAccountHolderName: text('destination_account_holder_name').notNull(),
    destinationRoutingType: text('destination_routing_type').notNull(),
    destinationRoutingValueKeyVersion: text('destination_routing_value_key_version').notNull(),
    destinationRoutingValueNonce: text('destination_routing_value_nonce').notNull(),
    destinationRoutingValueCiphertext: text('destination_routing_value_ciphertext').notNull(),
    destinationRoutingValueAuthTag: text('destination_routing_value_auth_tag').notNull(),
    provider: text('provider').notNull(),
    providerReference: text('provider_reference').unique(),
    providerApiVersion: text('provider_api_version'),
    providerStatus: text('provider_status'),
    providerAmountSatang: integer('provider_amount_satang'),
    principalSatang: integer('principal_satang').notNull(),
    maximumFeeSatang: integer('maximum_fee_satang').notNull(),
    maximumTaxSatang: integer('maximum_tax_satang').notNull(),
    maximumDebitSatang: integer('maximum_debit_satang').notNull(),
    actualFeeSatang: integer('actual_fee_satang'),
    actualTaxSatang: integer('actual_tax_satang'),
    actualDebitSatang: integer('actual_debit_satang'),
    payoutStatus: text('payout_status').$type<PayoutStatus>().notNull(),
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
      sql`${table.principalSatang} > 0 AND ${table.maximumFeeSatang} >= 0 AND ${table.maximumTaxSatang} >= 0 AND ${table.maximumDebitSatang} = ${table.principalSatang} + ${table.maximumFeeSatang} + ${table.maximumTaxSatang} AND (${table.providerAmountSatang} IS NULL OR ${table.providerAmountSatang} = ${table.principalSatang})`,
    ),
    check(
      'payment_payouts_actual_amount_check',
      sql`num_nonnulls(${table.actualFeeSatang}, ${table.actualTaxSatang}, ${table.actualDebitSatang}) IN (0, 3) AND (${table.actualFeeSatang} IS NULL OR (${table.actualFeeSatang} >= 0 AND ${table.actualTaxSatang} >= 0 AND ${table.actualDebitSatang} = ${table.principalSatang} + ${table.actualFeeSatang} + ${table.actualTaxSatang} AND ${table.actualDebitSatang} <= ${table.maximumDebitSatang}))`,
    ),
    check(
      'payment_payouts_destination_currency_check',
      sql`${table.destinationAccountCountry} = 'TH' AND ${table.destinationAccountCurrency} = 'THB'`,
    ),
    uniqueIndex('payment_payouts_active_user_uidx')
      .on(table.userId)
      .where(sql`${table.payoutStatus} IN ('CREATING', 'PENDING', 'AWAITING_RECONCILIATION')`),
    unique('payment_payouts_id_user_key').on(table.id, table.userId),
    foreignKey({
      columns: [table.quoteId, table.userId],
      foreignColumns: [paymentPayoutQuotes.id, paymentPayoutQuotes.userId],
      name: 'payment_payouts_quote_user_fk',
    }),
    foreignKey({
      columns: [table.payoutAccountId, table.userId],
      foreignColumns: [paymentPayoutAccounts.id, paymentPayoutAccounts.userId],
      name: 'payment_payouts_account_user_fk',
    }),
  ],
);

export const paymentPayoutStatusHistory = pgTable(
  'payment_payout_status_history',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    payoutId: uuid('payout_id').notNull().references(() => paymentPayouts.id),
    fromStatus: text('from_status').$type<PayoutStatus>(),
    toStatus: text('to_status').$type<PayoutStatus>().notNull(),
    providerStatus: text('provider_status'),
    actorUserId: text('actor_user_id').references(() => authUser.id),
    actorAdminId: text('actor_admin_id').references(() => authAdmin.id),
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
    adminId: text('admin_id').notNull().references(() => authAdmin.id),
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
