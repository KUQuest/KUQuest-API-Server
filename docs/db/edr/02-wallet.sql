-- ==================== wallet / ledger (Wallet & Payments) ====================
-- Implemented by BE-109. PostgreSQL INTEGER values are exact satang; THB currency is
-- implicit and is formatted only at API/UI boundaries. Quest tables are not referenced.

CREATE TABLE wallet_wallets (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     TEXT NOT NULL UNIQUE REFERENCES auth_user(id),
  spending_balance_satang     INTEGER NOT NULL DEFAULT 0,
  earnings_balance_satang     INTEGER NOT NULL DEFAULT 0,
  funding_reserved_satang     INTEGER NOT NULL DEFAULT 0,
  reserved_for_payouts_satang INTEGER NOT NULL DEFAULT 0,
  wallet_status               TEXT NOT NULL DEFAULT 'ACTIVE'
                              CHECK (wallet_status IN ('ACTIVE', 'FROZEN', 'SUSPENDED', 'CLOSED')),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    spending_balance_satang >= 0
    AND earnings_balance_satang >= 0
    AND funding_reserved_satang >= 0
    AND reserved_for_payouts_satang >= 0
  ),
  CHECK (
    spending_balance_satang
    + earnings_balance_satang
    + funding_reserved_satang
    + reserved_for_payouts_satang <= 2000000000
  )
);

CREATE TABLE wallet_status_history (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id      UUID NOT NULL REFERENCES wallet_wallets(id),
  from_status    TEXT CHECK (from_status IN ('ACTIVE', 'FROZEN', 'SUSPENDED', 'CLOSED')),
  to_status      TEXT NOT NULL CHECK (to_status IN ('ACTIVE', 'FROZEN', 'SUSPENDED', 'CLOSED')),
  actor_user_id  TEXT REFERENCES auth_user(id),
  actor_admin_id TEXT REFERENCES auth_admin(id),
  reason         TEXT,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(actor_user_id, actor_admin_id) <= 1)
);
CREATE INDEX wallet_status_history_wallet_idx
  ON wallet_status_history (wallet_id, occurred_at);
CREATE UNIQUE INDEX wallet_status_history_initial_uidx
  ON wallet_status_history (wallet_id) WHERE from_status IS NULL;

CREATE TABLE wallet_ledger_accounts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code       TEXT NOT NULL UNIQUE,
  type       TEXT NOT NULL CHECK (type IN (
    'SPENDING',
    'EARNINGS',
    'FUNDING_RESERVED',
    'RESERVED_FOR_PAYOUTS',
    'PLATFORM_REVENUE',
    'PLATFORM_SUSPENSE'
  )),
  wallet_id  UUID REFERENCES wallet_wallets(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((wallet_id IS NULL) = (type IN ('PLATFORM_REVENUE', 'PLATFORM_SUSPENSE')))
);
CREATE UNIQUE INDEX wallet_ledger_accounts_wallet_type_uidx
  ON wallet_ledger_accounts (wallet_id, type) WHERE wallet_id IS NOT NULL;

CREATE TABLE wallet_idempotency_keys (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_user_id TEXT NOT NULL REFERENCES auth_user(id),
  operation_scope   TEXT NOT NULL,
  key               TEXT NOT NULL,
  request_hash      TEXT NOT NULL,
  resource_type     TEXT,
  resource_id       TEXT,
  processing_status TEXT NOT NULL DEFAULT 'PROCESSING'
                    CHECK (processing_status IN ('PROCESSING', 'COMPLETED')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ NOT NULL,
  UNIQUE (principal_user_id, operation_scope, key),
  CHECK ((processing_status = 'COMPLETED') = (completed_at IS NOT NULL))
);
CREATE INDEX wallet_idempotency_keys_expiry_idx ON wallet_idempotency_keys (expires_at);

CREATE TABLE wallet_ledger_transactions (
  id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_reference           TEXT NOT NULL UNIQUE,
  event_type                   TEXT NOT NULL CHECK (event_type IN (
    'TOP_UP',
    'PAYOUT',
    'FUNDING_RESERVE',
    'FUNDING_RELEASE',
    'ADJUSTMENT',
    'EARNINGS_CONVERSION'
  )),
  idempotency_key_id           UUID UNIQUE REFERENCES wallet_idempotency_keys(id),
  correction_of_transaction_id UUID REFERENCES wallet_ledger_transactions(id),
  created_by_user_id           TEXT REFERENCES auth_user(id),
  description                  TEXT,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sealed_at                    TIMESTAMPTZ
);

CREATE TABLE wallet_ledger_postings (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES wallet_ledger_transactions(id),
  account_id     UUID NOT NULL REFERENCES wallet_ledger_accounts(id),
  amount_satang  INTEGER NOT NULL CHECK (
    amount_satang <> 0 AND amount_satang BETWEEN -2000000000 AND 2000000000
  ),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX wallet_ledger_postings_transaction_idx
  ON wallet_ledger_postings (transaction_id);
CREATE INDEX wallet_ledger_postings_account_idx
  ON wallet_ledger_postings (account_id, created_at);

CREATE TABLE wallet_activities (
  id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_transaction_id        UUID NOT NULL REFERENCES wallet_ledger_transactions(id),
  user_id                      TEXT NOT NULL REFERENCES auth_user(id),
  type                         TEXT NOT NULL CHECK (type IN ('TOP_UP', 'SPEND', 'EARN', 'HOLD', 'RELEASE')),
  activity_status              TEXT NOT NULL CHECK (activity_status IN ('PENDING', 'COMPLETED', 'FAILED')),
  spending_delta_satang        INTEGER NOT NULL DEFAULT 0,
  earnings_delta_satang        INTEGER NOT NULL DEFAULT 0,
  funding_reserved_delta_satang INTEGER NOT NULL DEFAULT 0,
  payout_reserved_delta_satang INTEGER NOT NULL DEFAULT 0,
  resource_type                TEXT,
  resource_id                  TEXT,
  occurred_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ledger_transaction_id, user_id)
);
CREATE INDEX wallet_activities_user_time_idx
  ON wallet_activities (user_id, occurred_at);

-- Migration triggers additionally enforce these cross-row invariants:
-- 1. Wallet account ownership is derived only through wallet_id;
-- 2. Wallet ownership cannot be reassigned;
-- 3. sealing requires at least two postings whose exact satang sum is zero;
-- 4. authoritative financial records cannot be hard deleted; sealed transactions
--    and their postings also cannot be updated. Wallet activities are rebuildable
--    projections. Close/freeze by status and correct ledger facts with a new
--    balanced correction transaction.
