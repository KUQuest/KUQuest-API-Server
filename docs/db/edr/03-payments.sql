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
  authored_by_admin_id            TEXT REFERENCES auth_admin(id),
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
  user_id              TEXT NOT NULL REFERENCES auth_user(id),
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
  CHECK (credit_satang > 0 AND charged_fee_satang >= 0 AND charged_tax_satang >= 0 AND payment_total_satang = credit_satang + charged_fee_satang + charged_tax_satang AND provider_fee_satang >= 0 AND provider_tax_satang >= 0 AND provider_total_satang = credit_satang + provider_fee_satang + provider_tax_satang)
);
CREATE INDEX payment_top_up_quotes_expiry_idx ON payment_top_up_quotes (expires_at);

CREATE TABLE payment_top_ups (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  internal_reference          TEXT NOT NULL UNIQUE,
  user_id                     TEXT NOT NULL REFERENCES auth_user(id),
  quote_id                    UUID NOT NULL UNIQUE REFERENCES payment_top_up_quotes(id),
  provider                    TEXT NOT NULL,
  provider_reference          TEXT UNIQUE,
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
  CHECK (credit_satang > 0 AND charged_fee_satang >= 0 AND charged_tax_satang >= 0 AND payment_total_satang = credit_satang + charged_fee_satang + charged_tax_satang AND provider_fee_satang >= 0 AND provider_tax_satang >= 0 AND provider_total_satang = credit_satang + provider_fee_satang + provider_tax_satang)
);
CREATE INDEX payment_top_ups_user_status_idx ON payment_top_ups (user_id, top_up_status);

CREATE TABLE payment_top_up_status_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  top_up_id       UUID NOT NULL REFERENCES payment_top_ups(id),
  -- from_status/to_status inherit payment_top_ups.top_up_status's vocab (see above).
  from_status     TEXT CHECK (from_status IN ('PENDING', 'PAID', 'EXPIRED', 'FAILED')),
  to_status       TEXT NOT NULL CHECK (to_status IN ('PENDING', 'PAID', 'EXPIRED', 'FAILED')),
  provider_status TEXT,
  actor_user_id   TEXT REFERENCES auth_user(id),
  actor_admin_id  TEXT REFERENCES auth_admin(id),
  source          TEXT NOT NULL,
  reason          TEXT,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(actor_user_id, actor_admin_id) <= 1)
);
CREATE INDEX payment_top_up_status_history_idx ON payment_top_up_status_history (top_up_id, occurred_at);

CREATE TABLE payment_payout_accounts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             TEXT NOT NULL REFERENCES auth_user(id),
  -- recipient_type/routing_type settled via /grilling (2026-08-09): recipient_type is a
  -- real fixed vocab (does payout go to the account-holder or someone else, per
  -- `relationship` below) — CHECK added. routing_type deliberately left open TEXT, no
  -- CHECK — genuinely provider/bank-rail-defined (e.g. PROMPTPAY/BANK_ACCOUNT), may grow
  -- without a schema decision.
  recipient_type      TEXT NOT NULL CHECK (recipient_type IN ('SELF', 'THIRD_PARTY')),
  given_name          TEXT NOT NULL,
  surname             TEXT NOT NULL,
  relationship        TEXT NOT NULL,
  account_country     TEXT NOT NULL DEFAULT 'TH',
  account_currency    TEXT NOT NULL DEFAULT 'THB',
  bank_code           TEXT NOT NULL,
  account_number      TEXT NOT NULL,
  account_holder_name TEXT NOT NULL,
  routing_type        TEXT NOT NULL,
  routing_value       TEXT NOT NULL,
  masked_last_four    TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at          TIMESTAMPTZ,
  CHECK (account_country = 'TH' AND account_currency = 'THB')
);
CREATE UNIQUE INDEX payment_payout_accounts_active_user_uidx ON payment_payout_accounts (user_id) WHERE retired_at IS NULL;

CREATE TABLE payment_payout_quotes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             TEXT NOT NULL REFERENCES auth_user(id),
  payout_account_id   UUID NOT NULL REFERENCES payment_payout_accounts(id),
  policy_revision_id  UUID NOT NULL REFERENCES payment_money_policy_revisions(id),
  receipt_satang        INTEGER NOT NULL,
  maximum_fee_satang    INTEGER NOT NULL,
  maximum_tax_satang    INTEGER NOT NULL,
  maximum_debit_satang  INTEGER NOT NULL,
  quoted_fee_satang   INTEGER NOT NULL,
  quoted_tax_satang   INTEGER NOT NULL,
  quoted_debit_satang INTEGER NOT NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  consumed_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (receipt_satang > 0 AND maximum_fee_satang >= 0 AND maximum_tax_satang >= 0 AND maximum_debit_satang = receipt_satang + maximum_fee_satang + maximum_tax_satang AND quoted_fee_satang >= 0 AND quoted_tax_satang >= 0 AND quoted_debit_satang = receipt_satang + quoted_fee_satang + quoted_tax_satang)
);
CREATE INDEX payment_payout_quotes_expiry_idx ON payment_payout_quotes (expires_at);

CREATE TABLE payment_payouts (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                       TEXT NOT NULL REFERENCES auth_user(id),
  quote_id                      UUID NOT NULL UNIQUE REFERENCES payment_payout_quotes(id),
  payout_account_id             UUID NOT NULL REFERENCES payment_payout_accounts(id),
  destination_recipient_type    TEXT NOT NULL CHECK (destination_recipient_type IN ('SELF', 'THIRD_PARTY')),
  destination_given_name        TEXT NOT NULL,
  destination_surname           TEXT NOT NULL,
  destination_relationship      TEXT NOT NULL,
  destination_account_country   TEXT NOT NULL,
  destination_account_currency  TEXT NOT NULL,
  destination_bank_code         TEXT NOT NULL,
  destination_account_number    TEXT NOT NULL,
  destination_account_holder_name TEXT NOT NULL,
  destination_routing_type      TEXT NOT NULL,
  destination_routing_value     TEXT NOT NULL,
  provider                      TEXT NOT NULL,
  provider_reference            TEXT UNIQUE,
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
  CHECK (principal_satang > 0 AND maximum_fee_satang >= 0 AND maximum_tax_satang >= 0 AND maximum_debit_satang = principal_satang + maximum_fee_satang + maximum_tax_satang),
  CHECK (num_nonnulls(actual_fee_satang, actual_tax_satang, actual_debit_satang) IN (0, 3)),
  CHECK (actual_fee_satang IS NULL OR (actual_fee_satang >= 0 AND actual_tax_satang >= 0 AND actual_debit_satang = principal_satang + actual_fee_satang + actual_tax_satang AND actual_debit_satang <= maximum_debit_satang)),
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
  actor_user_id   TEXT REFERENCES auth_user(id),
  actor_admin_id  TEXT REFERENCES auth_admin(id),
  source          TEXT NOT NULL,
  reason          TEXT,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(actor_user_id, actor_admin_id) <= 1)
);
CREATE INDEX payment_payout_status_history_idx ON payment_payout_status_history (payout_id, occurred_at);

CREATE TABLE payment_payout_cancellation_attempts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id        UUID NOT NULL REFERENCES payment_payouts(id),
  admin_id         TEXT NOT NULL REFERENCES auth_admin(id),
  reason           TEXT NOT NULL,
  -- attempt_status vocab settled via /grilling (2026-08-09).
  attempt_status   TEXT NOT NULL CHECK (attempt_status IN ('PENDING', 'SUCCEEDED', 'FAILED')),
  provider_response JSONB,
  attempted_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payment_payout_cancellation_attempts_payout_idx ON payment_payout_cancellation_attempts (payout_id, attempted_at);
