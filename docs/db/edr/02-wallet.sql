-- ==================== wallet / ledger (Wallet & Payments) ====================
-- ported from ledger.schema.ts (drizzle draft); admin-acted columns repointed to auth_admin(id);
-- actor columns that can be user OR admin OR system made polymorphic (dual nullable FK, <=1 set)

CREATE TABLE wallet_wallets (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID NOT NULL UNIQUE REFERENCES auth_user(id),
  spending_balance_baht    BIGINT NOT NULL DEFAULT 0,
  earnings_balance_baht    BIGINT NOT NULL DEFAULT 0,
  held_for_jobs_baht       BIGINT NOT NULL DEFAULT 0,
  reserved_for_payouts_baht BIGINT NOT NULL DEFAULT 0,
  -- wallet_status vocab settled via /grilling (2026-08-09): ACTIVE (normal), FROZEN
  -- (temporary admin hold, e.g. fraud review — reversible), SUSPENDED (policy-violation
  -- lock, reversible, needs review to lift), CLOSED (terminal, no reversal).
  wallet_status            TEXT NOT NULL DEFAULT 'ACTIVE'
                           CHECK (wallet_status IN ('ACTIVE', 'FROZEN', 'SUSPENDED', 'CLOSED')),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (spending_balance_baht >= 0 AND earnings_balance_baht >= 0 AND held_for_jobs_baht >= 0 AND reserved_for_payouts_baht >= 0)
);
CREATE TABLE wallet_status_history (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id      UUID NOT NULL REFERENCES wallet_wallets(id),
  -- from_status/to_status inherit wallet_wallets.wallet_status's vocab (see above).
  -- from_status nullable (first-ever row for a wallet has no prior status).
  from_status    TEXT CHECK (from_status IN ('ACTIVE', 'FROZEN', 'SUSPENDED', 'CLOSED')),
  to_status      TEXT NOT NULL CHECK (to_status IN ('ACTIVE', 'FROZEN', 'SUSPENDED', 'CLOSED')),
  actor_user_id  UUID REFERENCES auth_user(id),
  actor_admin_id UUID REFERENCES auth_admin(id),
  reason         TEXT,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(actor_user_id, actor_admin_id) <= 1)
);
CREATE INDEX wallet_status_history_wallet_idx ON wallet_status_history (wallet_id, occurred_at);

CREATE TABLE wallet_ledger_accounts (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code      TEXT NOT NULL UNIQUE,
  -- type vocab settled via /grilling (2026-08-09): wallet-linked rows use wallet_wallets'
  -- own 4 compartments; wallet_id/user_id-both-NULL rows are platform/system accounts —
  -- PLATFORM_REVENUE (fee collection), PLATFORM_SUSPENSE (unreconciled/in-transit float).
  -- Correlation CHECK below ties the two platform types to the both-NULL rows exactly.
  type      TEXT NOT NULL CHECK (type IN ('SPENDING', 'EARNINGS', 'HELD_FOR_JOBS', 'RESERVED_FOR_PAYOUTS', 'PLATFORM_REVENUE', 'PLATFORM_SUSPENSE')),
  currency  TEXT NOT NULL DEFAULT 'THB',
  wallet_id UUID REFERENCES wallet_wallets(id),
  user_id   UUID REFERENCES auth_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (currency = 'THB'),
  CHECK ((wallet_id IS NULL) = (user_id IS NULL)),
  CHECK ((wallet_id IS NULL) = (type IN ('PLATFORM_REVENUE', 'PLATFORM_SUSPENSE')))
);
CREATE UNIQUE INDEX wallet_ledger_accounts_wallet_type_uidx ON wallet_ledger_accounts (wallet_id, type) WHERE wallet_id IS NOT NULL;

CREATE TABLE wallet_idempotency_keys (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_user_id UUID NOT NULL REFERENCES auth_user(id),
  operation_scope  TEXT NOT NULL,
  key              TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  resource_type    TEXT,
  resource_id      TEXT,
  response_status  INTEGER,
  response_body    JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  UNIQUE (principal_user_id, operation_scope, key)
);
CREATE INDEX wallet_idempotency_keys_expiry_idx ON wallet_idempotency_keys (expires_at);

CREATE TABLE wallet_ledger_transactions (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_reference          TEXT NOT NULL UNIQUE,
  -- event_type vocab settled via /grilling (2026-08-09): hold/release split into two
  -- distinct events (separate postings at separate times), not one combined value.
  event_type                  TEXT NOT NULL CHECK (event_type IN ('TOP_UP', 'PAYOUT', 'ESCROW_HOLD', 'ESCROW_RELEASE', 'ADJUSTMENT', 'EARNINGS_CONVERSION')),
  idempotency_key_id          UUID UNIQUE REFERENCES wallet_idempotency_keys(id),
  correction_of_transaction_id UUID REFERENCES wallet_ledger_transactions(id),
  created_by_user_id          UUID REFERENCES auth_user(id),
  description                 TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sealed_at                   TIMESTAMPTZ
);

CREATE TABLE wallet_ledger_postings (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES wallet_ledger_transactions(id),
  account_id     UUID NOT NULL REFERENCES wallet_ledger_accounts(id),
  amount_baht    BIGINT NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'THB',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (amount_baht <> 0),
  CHECK (currency = 'THB')
);
CREATE INDEX wallet_ledger_postings_transaction_idx ON wallet_ledger_postings (transaction_id);
CREATE INDEX wallet_ledger_postings_account_idx ON wallet_ledger_postings (account_id, created_at);

CREATE TABLE wallet_earnings_conversions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES auth_user(id),
  amount_baht           BIGINT NOT NULL,
  ledger_transaction_id UUID NOT NULL UNIQUE REFERENCES wallet_ledger_transactions(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (amount_baht > 0)
);

CREATE TABLE wallet_activities (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID NOT NULL REFERENCES auth_user(id),
  -- type/activity_status vocab settled via /grilling (2026-08-09).
  type                      TEXT NOT NULL CHECK (type IN ('TOP_UP', 'SPEND', 'EARN', 'HOLD', 'RELEASE')),
  activity_status           TEXT NOT NULL CHECK (activity_status IN ('PENDING', 'COMPLETED', 'FAILED')),
  spending_delta_baht       BIGINT NOT NULL DEFAULT 0,
  earnings_delta_baht       BIGINT NOT NULL DEFAULT 0,
  job_held_delta_baht       BIGINT NOT NULL DEFAULT 0,
  payout_reserved_delta_baht BIGINT NOT NULL DEFAULT 0,
  resource_type             TEXT,
  resource_id               TEXT,
  occurred_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX wallet_activities_user_time_idx ON wallet_activities (user_id, occurred_at);

CREATE TABLE wallet_adjustments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id             UUID NOT NULL REFERENCES wallet_wallets(id),
  admin_id              UUID NOT NULL REFERENCES auth_admin(id),
  -- compartment vocab confirmed via /grilling (2026-08-09): same 4 spellings as
  -- wallet_ledger_accounts.type's wallet-linked compartments (platform types don't apply
  -- here — adjustments always target a specific wallet).
  compartment           TEXT NOT NULL CHECK (compartment IN ('SPENDING', 'EARNINGS', 'HELD_FOR_JOBS', 'RESERVED_FOR_PAYOUTS')),
  amount_baht           BIGINT NOT NULL,
  reason                TEXT NOT NULL,
  ledger_transaction_id UUID NOT NULL UNIQUE REFERENCES wallet_ledger_transactions(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (amount_baht <> 0)
);

CREATE TABLE wallet_amounts_owed (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES auth_user(id),
  amount_baht    BIGINT NOT NULL,
  recovered_baht BIGINT NOT NULL DEFAULT 0,
  reason         TEXT NOT NULL,
  source_type    TEXT NOT NULL,
  source_id      TEXT,
  -- owed_status vocab settled via /grilling (2026-08-09).
  owed_status    TEXT NOT NULL CHECK (owed_status IN ('OUTSTANDING', 'RECOVERED', 'WRITTEN_OFF')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (amount_baht > 0 AND recovered_baht >= 0 AND recovered_baht <= amount_baht)
);
