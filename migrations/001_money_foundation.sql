CREATE TABLE IF NOT EXISTS money_policies (
  revision integer PRIMARY KEY CHECK (revision > 0),
  platform_fee_bps integer NOT NULL CHECK (platform_fee_bps = 200),
  high_value_resolution_threshold integer NOT NULL CHECK (high_value_resolution_threshold > 0),
  top_up_min integer NOT NULL CHECK (top_up_min > 0),
  top_up_max integer NOT NULL CHECK (top_up_max >= top_up_min),
  funded_job_min integer NOT NULL CHECK (funded_job_min > 0),
  funded_job_max integer NOT NULL CHECK (funded_job_max >= funded_job_min),
  earnings_conversion_min integer NOT NULL CHECK (earnings_conversion_min > 0),
  earnings_conversion_max integer NOT NULL CHECK (earnings_conversion_max >= earnings_conversion_min),
  payout_min integer NOT NULL CHECK (payout_min > 0),
  payout_max integer NOT NULL CHECK (payout_max >= payout_min),
  effective_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO money_policies (
  revision,
  platform_fee_bps,
  high_value_resolution_threshold,
  top_up_min,
  top_up_max,
  funded_job_min,
  funded_job_max,
  earnings_conversion_min,
  earnings_conversion_max,
  payout_min,
  payout_max
) VALUES (1, 200, 10000, 1, 700000, 1, 700000, 1, 700000, 1, 700000)
ON CONFLICT (revision) DO NOTHING;

CREATE TABLE IF NOT EXISTS wallets (
  id text PRIMARY KEY,
  user_id text NOT NULL UNIQUE,
  currency text NOT NULL DEFAULT 'THB' CHECK (currency = 'THB'),
  spending_balance integer NOT NULL DEFAULT 0 CHECK (spending_balance >= 0),
  earnings_balance integer NOT NULL DEFAULT 0 CHECK (earnings_balance >= 0),
  held_for_jobs integer NOT NULL DEFAULT 0 CHECK (held_for_jobs >= 0),
  reserved_for_payouts integer NOT NULL DEFAULT 0 CHECK (reserved_for_payouts >= 0),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'FROZEN')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_accounts (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  compartment text NOT NULL CHECK (compartment IN ('SPENDING', 'EARNINGS')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, compartment)
);

CREATE TABLE IF NOT EXISTS ledger_transactions (
  id text PRIMARY KEY,
  type text NOT NULL,
  actor_user_id text,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_postings (
  id text PRIMARY KEY,
  transaction_id text NOT NULL REFERENCES ledger_transactions(id),
  account_id text NOT NULL REFERENCES ledger_accounts(id),
  amount integer NOT NULL CHECK (amount <> 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ledger_postings_transaction_idx
  ON ledger_postings (transaction_id);
CREATE INDEX IF NOT EXISTS ledger_postings_account_idx
  ON ledger_postings (account_id, created_at);

CREATE OR REPLACE FUNCTION reject_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger history is immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_transactions_immutable ON ledger_transactions;
CREATE TRIGGER ledger_transactions_immutable
BEFORE UPDATE OR DELETE ON ledger_transactions
FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

DROP TRIGGER IF EXISTS ledger_postings_immutable ON ledger_postings;
CREATE TRIGGER ledger_postings_immutable
BEFORE UPDATE OR DELETE ON ledger_postings
FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

CREATE OR REPLACE FUNCTION enforce_balanced_ledger_transaction() RETURNS trigger AS $$
DECLARE
  target_transaction_id text;
  posting_total bigint;
BEGIN
  target_transaction_id := COALESCE(NEW.transaction_id, OLD.transaction_id);
  SELECT COALESCE(SUM(amount), 0)
    INTO posting_total
    FROM ledger_postings
    WHERE transaction_id = target_transaction_id;

  IF posting_total <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced by %',
      target_transaction_id, posting_total;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_transaction_balance ON ledger_postings;
CREATE CONSTRAINT TRIGGER ledger_transaction_balance
AFTER INSERT ON ledger_postings
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_balanced_ledger_transaction();

CREATE TABLE IF NOT EXISTS wallet_activities (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  status text NOT NULL,
  spending_delta integer NOT NULL DEFAULT 0,
  earnings_delta integer NOT NULL DEFAULT 0,
  held_jobs_delta integer NOT NULL DEFAULT 0,
  reserved_payouts_delta integer NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'THB' CHECK (currency = 'THB'),
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wallet_activities_user_time_idx
  ON wallet_activities (user_id, occurred_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS idempotency_records (
  actor_id text NOT NULL,
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (actor_id, operation, idempotency_key)
);

CREATE TABLE IF NOT EXISTS provider_webhook_inbox (
  id text PRIMARY KEY,
  provider text NOT NULL CHECK (provider = 'XENDIT'),
  event_key text NOT NULL,
  event_type text NOT NULL,
  object_id text,
  payload jsonb NOT NULL,
  processing_status text NOT NULL DEFAULT 'PENDING'
    CHECK (processing_status IN ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED')),
  received_at timestamptz NOT NULL,
  processed_at timestamptz,
  last_error text,
  UNIQUE (provider, event_key)
);

CREATE INDEX IF NOT EXISTS provider_webhook_pending_idx
  ON provider_webhook_inbox (processing_status, received_at);
