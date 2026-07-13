ALTER TABLE ledger_accounts
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE ledger_accounts
  DROP CONSTRAINT IF EXISTS ledger_accounts_compartment_check;

ALTER TABLE ledger_accounts
  ADD CONSTRAINT ledger_accounts_compartment_check CHECK (
    compartment IN (
      'SPENDING',
      'EARNINGS',
      'SYSTEM_CLEARING',
      'PROVIDER_ASSET',
      'JOB_HELD',
      'PAYOUT_CLEARING',
      'PLATFORM_REVENUE'
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS ledger_accounts_system_compartment_idx
  ON ledger_accounts (compartment)
  WHERE user_id IS NULL;

INSERT INTO ledger_accounts (id, user_id, compartment)
VALUES
  ('lac_system_clearing', NULL, 'SYSTEM_CLEARING'),
  ('lac_provider_asset', NULL, 'PROVIDER_ASSET'),
  ('lac_job_held', NULL, 'JOB_HELD'),
  ('lac_payout_clearing', NULL, 'PAYOUT_CLEARING'),
  ('lac_platform_revenue', NULL, 'PLATFORM_REVENUE')
ON CONFLICT DO NOTHING;
