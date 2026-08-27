-- ==================== payments (Wallet & Payments) ====================
-- ported from payments.schema.ts (drizzle draft); admin-acted columns repointed to auth_admin(id);
-- actor columns that can be user OR admin OR system made polymorphic (dual nullable FK, <=1 set)

CREATE TABLE payment_money_policy_revisions (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  revision                        INTEGER NOT NULL UNIQUE,
  minimum_top_up_satang             INTEGER NOT NULL,
  maximum_top_up_satang             INTEGER NOT NULL,
  minimum_funding_reservation_satang INTEGER NOT NULL,
  maximum_funding_reservation_satang INTEGER NOT NULL,
  minimum_earnings_conversion_satang INTEGER NOT NULL,
  maximum_earnings_conversion_satang INTEGER NOT NULL,
  minimum_payout_satang             INTEGER NOT NULL,
  maximum_payout_satang             INTEGER NOT NULL,
  platform_fee_bps                SMALLINT NOT NULL,
  fee_rounding_mode               TEXT NOT NULL DEFAULT 'UP' CHECK (fee_rounding_mode = 'UP'),
  top_up_provider_fee_satang      INTEGER NOT NULL DEFAULT 0,
  top_up_provider_tax_bps         SMALLINT NOT NULL DEFAULT 0,
  payout_provider_fee_satang      INTEGER NOT NULL DEFAULT 0,
  payout_provider_tax_bps         SMALLINT NOT NULL DEFAULT 0,
  quote_lifetime_seconds          INTEGER NOT NULL,
  authored_by_admin_id            UUID REFERENCES auth_admin(id),
  reason                          TEXT NOT NULL,
  effective_from                  TIMESTAMPTZ NOT NULL,
  effective_until                 TIMESTAMPTZ,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (minimum_top_up_satang > 0 AND maximum_top_up_satang >= minimum_top_up_satang AND minimum_funding_reservation_satang > 0 AND maximum_funding_reservation_satang >= minimum_funding_reservation_satang AND minimum_earnings_conversion_satang > 0 AND maximum_earnings_conversion_satang >= minimum_earnings_conversion_satang AND minimum_payout_satang > 0 AND maximum_payout_satang >= minimum_payout_satang),
  CHECK (platform_fee_bps BETWEEN 0 AND 10000 AND top_up_provider_fee_satang >= 0 AND top_up_provider_tax_bps BETWEEN 0 AND 10000 AND payout_provider_fee_satang >= 0 AND payout_provider_tax_bps BETWEEN 0 AND 10000),
  CHECK (quote_lifetime_seconds > 0),
  CHECK (effective_until IS NULL OR effective_until > effective_from)
);

CREATE TABLE payment_top_up_quotes (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fee_rounding_mode    TEXT NOT NULL DEFAULT 'UP' CHECK (fee_rounding_mode = 'UP'),
  user_id              UUID NOT NULL REFERENCES auth_user(id),
  policy_revision_id   UUID NOT NULL REFERENCES payment_money_policy_revisions(id),
  credit_satang          INTEGER NOT NULL,
  charged_fee_satang     INTEGER NOT NULL,
  charged_tax_satang     INTEGER NOT NULL,
  payment_total_satang   INTEGER NOT NULL,
  provider_fee_satang  INTEGER NOT NULL,
  provider_tax_satang  INTEGER NOT NULL,
  provider_total_satang INTEGER NOT NULL,
  expires_at           TIMESTAMPTZ NOT NULL,
  consumed_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  CHECK (credit_satang > 0 AND charged_fee_satang >= 0 AND charged_tax_satang >= 0 AND payment_total_satang = credit_satang + charged_fee_satang + charged_tax_satang AND provider_fee_satang >= 0 AND provider_tax_satang >= 0 AND provider_total_satang = credit_satang + provider_fee_satang + provider_tax_satang)
);
CREATE INDEX payment_top_up_quotes_expiry_idx ON payment_top_up_quotes (expires_at);

CREATE TABLE payment_top_ups (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  internal_reference          TEXT NOT NULL UNIQUE,
  user_id                     UUID NOT NULL REFERENCES auth_user(id),
  quote_id                    UUID NOT NULL UNIQUE REFERENCES payment_top_up_quotes(id),
  provider                    TEXT NOT NULL,
  provider_reference          TEXT UNIQUE,
  provider_api_version        TEXT,
  provider_status             TEXT,
  provider_amount_satang      INTEGER,
  provider_channel_code       TEXT,
  credit_satang                 INTEGER NOT NULL,
  charged_fee_satang            INTEGER NOT NULL,
  charged_tax_satang            INTEGER NOT NULL,
  payment_total_satang          INTEGER NOT NULL,
  provider_fee_satang         INTEGER NOT NULL,
  provider_tax_satang         INTEGER NOT NULL,
  provider_total_satang       INTEGER NOT NULL,
  qr_payload                  TEXT,
  qr_expires_at                TIMESTAMPTZ,
  -- top_up_status vocab settled via /grilling (2026-08-09).
  top_up_status               TEXT NOT NULL CHECK (top_up_status IN ('PENDING', 'PAID', 'EXPIRED', 'FAILED')),
  credited_ledger_transaction_id UUID UNIQUE REFERENCES wallet_ledger_transactions(id),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  FOREIGN KEY (quote_id, user_id) REFERENCES payment_top_up_quotes(id, user_id),
  CHECK (credit_satang > 0 AND charged_fee_satang >= 0 AND charged_tax_satang >= 0 AND payment_total_satang = credit_satang + charged_fee_satang + charged_tax_satang AND provider_fee_satang >= 0 AND provider_tax_satang >= 0 AND provider_total_satang = credit_satang + provider_fee_satang + provider_tax_satang AND (provider_amount_satang IS NULL OR provider_amount_satang = payment_total_satang))
);
CREATE INDEX payment_top_ups_user_status_idx ON payment_top_ups (user_id, top_up_status);

CREATE TABLE payment_top_up_status_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  top_up_id       UUID NOT NULL REFERENCES payment_top_ups(id),
  -- from_status/to_status inherit payment_top_ups.top_up_status's vocab (see above).
  from_status     TEXT CHECK (from_status IN ('PENDING', 'PAID', 'EXPIRED', 'FAILED')),
  to_status       TEXT NOT NULL CHECK (to_status IN ('PENDING', 'PAID', 'EXPIRED', 'FAILED')),
  provider_status TEXT,
  actor_user_id   UUID REFERENCES auth_user(id),
  actor_admin_id  UUID REFERENCES auth_admin(id),
  source          TEXT NOT NULL,
  reason          TEXT,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(actor_user_id, actor_admin_id) <= 1)
);
CREATE INDEX payment_top_up_status_history_idx ON payment_top_up_status_history (top_up_id, occurred_at);
-- Top-up Quotes, Top-up status history, and Top-up rows are retained. Status
-- changes update the current row and append a history row; these records cannot
-- be hard-deleted.

CREATE TABLE payment_provider_event_inbox (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider              TEXT NOT NULL,
  provider_event_id     TEXT NOT NULL,
  event_type            TEXT NOT NULL,
  resource_type         TEXT NOT NULL,
  internal_reference    TEXT,
  provider_reference    TEXT,
  provider_api_version  TEXT,
  provider_status       TEXT NOT NULL,
  normalized_status     TEXT NOT NULL CHECK (normalized_status IN ('PENDING', 'PAID', 'EXPIRED', 'FAILED')),
  provider_amount_satang INTEGER CHECK (provider_amount_satang IS NULL OR provider_amount_satang > 0),
  provider_channel_code TEXT,
  provider_occurred_at  TIMESTAMPTZ NOT NULL,
  payload_hash          TEXT NOT NULL,
  raw_payload_key_version TEXT,
  raw_payload_nonce     TEXT,
  raw_payload_ciphertext TEXT,
  raw_payload_auth_tag  TEXT,
  raw_payload_expires_at TIMESTAMPTZ NOT NULL,
  processing_status     TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (processing_status IN ('RECEIVED', 'PROCESSING', 'RETRYABLE', 'PROCESSED', 'DEAD_LETTER')),
  attempt_count         SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  claimed_at            TIMESTAMPTZ,
  processed_at          TIMESTAMPTZ,
  last_error            TEXT,
  received_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id),
  CHECK (num_nonnulls(raw_payload_key_version, raw_payload_nonce, raw_payload_ciphertext, raw_payload_auth_tag) IN (0, 4))
);
CREATE INDEX payment_provider_event_inbox_processing_idx ON payment_provider_event_inbox (processing_status, received_at);
CREATE INDEX payment_provider_event_inbox_expiry_idx ON payment_provider_event_inbox (raw_payload_expires_at);

CREATE TABLE payment_provider_event_history (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     UUID NOT NULL REFERENCES payment_provider_event_inbox(id),
  from_status  TEXT CHECK (from_status IS NULL OR from_status IN ('RECEIVED', 'PROCESSING', 'RETRYABLE', 'PROCESSED', 'DEAD_LETTER')),
  to_status    TEXT NOT NULL CHECK (to_status IN ('RECEIVED', 'PROCESSING', 'RETRYABLE', 'PROCESSED', 'DEAD_LETTER')),
  source       TEXT NOT NULL,
  reason       TEXT,
  error        TEXT,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payment_provider_event_history_event_idx ON payment_provider_event_history (event_id, occurred_at);
-- Provider event inbox rows cannot be hard-deleted. History rows are immutable.

CREATE TABLE payment_payout_accounts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES auth_user(id),
  -- Only a Student's own destination is supported. Account and routing secrets
  -- are application-encrypted AES-256-GCM envelopes, not plaintext values.
  recipient_type      TEXT NOT NULL CHECK (recipient_type = 'SELF'),
  given_name          TEXT NOT NULL,
  surname             TEXT NOT NULL,
  relationship        TEXT NOT NULL,
  account_country     TEXT NOT NULL DEFAULT 'TH',
  account_currency    TEXT NOT NULL DEFAULT 'THB',
  bank_code           TEXT NOT NULL,
  account_number_key_version TEXT NOT NULL,
  account_number_nonce TEXT NOT NULL,
  account_number_ciphertext TEXT NOT NULL,
  account_number_auth_tag TEXT NOT NULL,
  account_holder_name TEXT NOT NULL,
  routing_type        TEXT NOT NULL CHECK (routing_type IN ('BANK_ACCOUNT', 'PROMPTPAY')),
  routing_value_key_version TEXT NOT NULL,
  routing_value_nonce TEXT NOT NULL,
  routing_value_ciphertext TEXT NOT NULL,
  routing_value_auth_tag TEXT NOT NULL,
  masked_last_four    TEXT NOT NULL,
  masked_routing_value TEXT NOT NULL DEFAULT '****',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at          TIMESTAMPTZ,
  CHECK (account_country = 'TH' AND account_currency = 'THB'),
  UNIQUE (id, user_id)
);
CREATE UNIQUE INDEX payment_payout_accounts_active_user_uidx ON payment_payout_accounts (user_id) WHERE retired_at IS NULL;

CREATE TABLE payment_payout_quotes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fee_rounding_mode   TEXT NOT NULL DEFAULT 'UP',
  user_id             UUID NOT NULL REFERENCES auth_user(id),
  payout_account_id   UUID NOT NULL REFERENCES payment_payout_accounts(id),
  policy_revision_id  UUID NOT NULL REFERENCES payment_money_policy_revisions(id),
  receipt_satang        INTEGER NOT NULL,
  maximum_fee_satang    INTEGER NOT NULL,
  maximum_tax_satang    INTEGER NOT NULL,
  maximum_debit_satang  INTEGER NOT NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  consumed_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  FOREIGN KEY (payout_account_id, user_id) REFERENCES payment_payout_accounts(id, user_id),
  CHECK (receipt_satang > 0 AND maximum_fee_satang >= 0 AND maximum_tax_satang >= 0 AND maximum_debit_satang = receipt_satang + maximum_fee_satang + maximum_tax_satang),
  CHECK (fee_rounding_mode = 'UP')
);
CREATE INDEX payment_payout_quotes_expiry_idx ON payment_payout_quotes (expires_at);

CREATE TABLE payment_payouts (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  internal_reference            TEXT NOT NULL UNIQUE,
  user_id                       UUID NOT NULL REFERENCES auth_user(id),
  quote_id                      UUID NOT NULL UNIQUE REFERENCES payment_payout_quotes(id),
  payout_account_id             UUID NOT NULL REFERENCES payment_payout_accounts(id),
  destination_recipient_type    TEXT NOT NULL CHECK (destination_recipient_type IN ('SELF', 'THIRD_PARTY')),
  destination_given_name        TEXT NOT NULL,
  destination_surname           TEXT NOT NULL,
  destination_relationship      TEXT NOT NULL,
  destination_account_country   TEXT NOT NULL,
  destination_account_currency  TEXT NOT NULL,
  destination_bank_code         TEXT NOT NULL,
  destination_account_number_key_version TEXT NOT NULL,
  destination_account_number_nonce TEXT NOT NULL,
  destination_account_number_ciphertext TEXT NOT NULL,
  destination_account_number_auth_tag TEXT NOT NULL,
  destination_account_holder_name TEXT NOT NULL,
  destination_routing_type      TEXT NOT NULL,
  destination_routing_value_key_version TEXT NOT NULL,
  destination_routing_value_nonce TEXT NOT NULL,
  destination_routing_value_ciphertext TEXT NOT NULL,
  destination_routing_value_auth_tag TEXT NOT NULL,
  provider                      TEXT NOT NULL,
  provider_reference            TEXT UNIQUE,
  provider_api_version          TEXT,
  provider_status               TEXT,
  provider_amount_satang        INTEGER,
  principal_satang                INTEGER NOT NULL,
  maximum_fee_satang               INTEGER NOT NULL,
  maximum_tax_satang                INTEGER NOT NULL,
  maximum_debit_satang              INTEGER NOT NULL,
  actual_fee_satang               INTEGER,
  actual_tax_satang               INTEGER,
  actual_debit_satang             INTEGER,
  -- payout_status vocab settled via /grilling (2026-08-09): the 3 non-terminal values
  -- payment_payouts_active_user_uidx below already relied on, plus 3 terminal states.
  payout_status                  TEXT NOT NULL CHECK (payout_status IN ('CREATING', 'PENDING', 'AWAITING_RECONCILIATION', 'COMPLETED', 'FAILED', 'CANCELLED')),
  reserve_ledger_transaction_id  UUID NOT NULL UNIQUE REFERENCES wallet_ledger_transactions(id),
  final_ledger_transaction_id    UUID UNIQUE REFERENCES wallet_ledger_transactions(id),
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (principal_satang > 0 AND maximum_fee_satang >= 0 AND maximum_tax_satang >= 0 AND maximum_debit_satang = principal_satang + maximum_fee_satang + maximum_tax_satang AND (provider_amount_satang IS NULL OR provider_amount_satang = principal_satang)),
  CHECK (num_nonnulls(actual_fee_satang, actual_tax_satang, actual_debit_satang) IN (0, 3)),
  CHECK (actual_fee_satang IS NULL OR (actual_fee_satang >= 0 AND actual_tax_satang >= 0 AND actual_debit_satang = principal_satang + actual_fee_satang + actual_tax_satang AND actual_debit_satang <= maximum_debit_satang)),
  FOREIGN KEY (quote_id, user_id) REFERENCES payment_payout_quotes(id, user_id),
  FOREIGN KEY (payout_account_id, user_id) REFERENCES payment_payout_accounts(id, user_id),
  UNIQUE (id, user_id),
  CHECK (destination_account_country = 'TH' AND destination_account_currency = 'THB')
);
CREATE UNIQUE INDEX payment_payouts_active_user_uidx ON payment_payouts (user_id) WHERE payout_status IN ('CREATING','PENDING','AWAITING_RECONCILIATION');

CREATE TABLE payment_payout_status_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id       UUID NOT NULL REFERENCES payment_payouts(id),
  -- from_status/to_status inherit payment_payouts.payout_status's vocab (see above).
  from_status     TEXT CHECK (from_status IN ('CREATING', 'PENDING', 'AWAITING_RECONCILIATION', 'COMPLETED', 'FAILED', 'CANCELLED')),
  to_status       TEXT NOT NULL CHECK (to_status IN ('CREATING', 'PENDING', 'AWAITING_RECONCILIATION', 'COMPLETED', 'FAILED', 'CANCELLED')),
  provider_status TEXT,
  actor_user_id   UUID REFERENCES auth_user(id),
  actor_admin_id  UUID REFERENCES auth_admin(id),
  source          TEXT NOT NULL,
  reason          TEXT,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(actor_user_id, actor_admin_id) <= 1)
);
CREATE INDEX payment_payout_status_history_idx ON payment_payout_status_history (payout_id, occurred_at);

CREATE TABLE payment_payout_cancellation_attempts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id        UUID NOT NULL REFERENCES payment_payouts(id),
  admin_id         UUID NOT NULL REFERENCES auth_admin(id),
  reason           TEXT NOT NULL,
  -- attempt_status vocab settled via /grilling (2026-08-09).
  attempt_status   TEXT NOT NULL CHECK (attempt_status IN ('PENDING', 'SUCCEEDED', 'FAILED')),
  provider_response JSONB,
  attempted_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payment_payout_cancellation_attempts_payout_idx ON payment_payout_cancellation_attempts (payout_id, attempted_at);
