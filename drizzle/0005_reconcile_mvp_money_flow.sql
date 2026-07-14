-- Reconcile installations where the original hand-authored 0004 timestamp was
-- older than an already-applied migration. Every operation is intentionally
-- safe whether 0004 ran or was skipped.
ALTER TABLE money_policy_revisions
  ADD COLUMN IF NOT EXISTS top_up_provider_fee_satang bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS top_up_provider_tax_bps bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payout_provider_fee_satang bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payout_provider_tax_bps bigint NOT NULL DEFAULT 0;

ALTER TABLE money_policy_revisions DROP CONSTRAINT IF EXISTS money_policy_fee_chk;
ALTER TABLE money_policy_revisions ADD CONSTRAINT money_policy_fee_chk CHECK (
  platform_fee_bps BETWEEN 0 AND 10000
  AND top_up_provider_fee_satang >= 0
  AND top_up_provider_tax_bps BETWEEN 0 AND 10000
  AND payout_provider_fee_satang >= 0
  AND payout_provider_tax_bps BETWEEN 0 AND 10000
);

INSERT INTO money_policy_revisions (
  revision, minimum_top_up_baht, maximum_top_up_baht,
  minimum_funded_job_baht, maximum_funded_job_baht,
  minimum_earnings_conversion_baht, maximum_earnings_conversion_baht,
  minimum_payout_baht, maximum_payout_baht, platform_fee_bps,
  top_up_provider_fee_satang, top_up_provider_tax_bps,
  payout_provider_fee_satang, payout_provider_tax_bps,
  dispute_two_person_threshold_baht, quote_lifetime_seconds,
  review_window_seconds, default_application_window_seconds,
  reason, effective_from
)
SELECT 2, minimum_top_up_baht, maximum_top_up_baht,
  minimum_funded_job_baht, maximum_funded_job_baht,
  minimum_earnings_conversion_baht, maximum_earnings_conversion_baht,
  minimum_payout_baht, maximum_payout_baht, 0, 0, 0, 0, 0,
  dispute_two_person_threshold_baht, quote_lifetime_seconds,
  review_window_seconds, default_application_window_seconds,
  'Development showcase policy: zero platform and provider fees', now()
FROM money_policy_revisions WHERE revision = 1
ON CONFLICT (revision) DO NOTHING;

CREATE TABLE IF NOT EXISTS development_test_users (
  user_id text PRIMARY KEY REFERENCES "user"(user_id),
  created_by_user_id text NOT NULL REFERENCES "user"(user_id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS development_test_users_created_by_idx
  ON development_test_users(created_by_user_id, created_at);

CREATE TABLE IF NOT EXISTS development_actor_sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(user_id),
  activated_by_user_id text NOT NULL REFERENCES "user"(user_id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS development_actor_sessions_user_idx ON development_actor_sessions(user_id);
CREATE INDEX IF NOT EXISTS development_actor_sessions_expiry_idx ON development_actor_sessions(expires_at);

DO $$
BEGIN
  IF to_regrole('kuquest_app') IS NOT NULL THEN
    GRANT SELECT ON jobs, job_status_history, job_applications,
      job_application_status_history, work_submissions,
      work_submission_status_history, top_up_quotes, top_ups,
      top_up_status_history, payout_accounts, payout_quotes, payouts,
      payout_status_history, platform_controls, provider_webhook_events,
      provider_webhook_event_status_history, scheduled_tasks,
      scheduled_task_status_history, development_test_users,
      development_actor_sessions TO kuquest_app;
    GRANT INSERT ON jobs, job_status_history, job_applications,
      job_application_status_history, work_submissions,
      work_submission_status_history, top_up_quotes, top_ups,
      top_up_status_history, payout_accounts, payout_quotes, payouts,
      payout_status_history, provider_webhook_event_status_history,
      scheduled_tasks, scheduled_task_status_history, audit_events,
      development_test_users, development_actor_sessions TO kuquest_app;
    GRANT UPDATE ON jobs, job_applications, work_submissions, top_up_quotes,
      top_ups, payout_accounts, payout_quotes, payouts,
      provider_webhook_events, scheduled_tasks TO kuquest_app;
    GRANT DELETE ON development_actor_sessions TO kuquest_app;
  END IF;
END $$;
