ALTER TABLE "user" ADD CONSTRAINT user_ku_email_chk CHECK (lower(email) ~ '^[^@]+@ku[.]th$');
ALTER TABLE account ADD CONSTRAINT account_provider_identity_uq UNIQUE(provider_id, account_id);
CREATE INDEX session_expires_at_idx ON session(expires_at);
CREATE INDEX verification_expires_at_idx ON verification(expires_at);
ALTER TABLE wallets ADD CONSTRAINT wallets_status_chk CHECK (status IN ('ACTIVE','FROZEN'));
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_type_chk CHECK (type IN ('SPENDING','EARNINGS','JOB_HELD','PAYOUT_RESERVED','PAYOUT_CLEARING','PROVIDER_ASSET','PLATFORM_REVENUE','ADJUSTMENTS','SHORTFALL'));
ALTER TABLE jobs ADD CONSTRAINT jobs_status_chk CHECK (status IN ('OPEN','ASSIGNED','OVERDUE','IN_REVIEW','DISPUTED','SETTLED','RETURNED','CANCELLED','EXPIRED'));
ALTER TABLE job_applications ADD CONSTRAINT job_applications_status_chk CHECK (status IN ('PENDING','SELECTED','WITHDRAWN','REJECTED','REMOVED_WORKER_ENGAGED'));
ALTER TABLE work_submissions ADD CONSTRAINT work_submissions_status_chk CHECK (status IN ('SUBMITTED','APPROVED','AUTO_APPROVED','DISPUTED'));
ALTER TABLE disputes ADD CONSTRAINT disputes_status_chk CHECK (status IN ('OPEN','PENDING_SECOND_APPROVAL','RESOLVED'));
ALTER TABLE dispute_resolutions ADD CONSTRAINT dispute_resolutions_outcome_chk CHECK (outcome IN ('RETURN_TO_EMPLOYER','SETTLE_TO_WORKER'));
ALTER TABLE top_ups ADD CONSTRAINT top_ups_status_chk CHECK (status IN ('CREATING','REQUIRES_ACTION','AWAITING_RECONCILIATION','SUCCEEDED','FAILED','EXPIRED'));
ALTER TABLE payouts ADD CONSTRAINT payouts_status_chk CHECK (status IN ('CREATING','PENDING','SUCCEEDED','FAILED','REVERSED','CANCELLED','AWAITING_RECONCILIATION'));
ALTER TABLE payout_cancellation_attempts ADD CONSTRAINT payout_cancellation_attempts_status_chk CHECK (status IN ('ATTEMPTED','ACCEPTED','REJECTED','FAILED'));
ALTER TABLE provider_webhook_events ADD CONSTRAINT provider_webhook_status_chk CHECK (status IN ('RECEIVED','PROCESSING','PROCESSED','RETRYABLE','DEAD_LETTER'));
ALTER TABLE scheduled_tasks ADD CONSTRAINT scheduled_tasks_status_chk CHECK (status IN ('PENDING','RUNNING','SUCCEEDED','RETRYABLE','FAILED','CANCELLED'));

INSERT INTO money_policy_revisions (
  revision, minimum_top_up_baht, maximum_top_up_baht,
  minimum_funded_job_baht, maximum_funded_job_baht,
  minimum_earnings_conversion_baht, maximum_earnings_conversion_baht,
  minimum_payout_baht, maximum_payout_baht, platform_fee_bps,
  dispute_two_person_threshold_baht, quote_lifetime_seconds,
  review_window_seconds, default_application_window_seconds,
  reason, effective_from
) VALUES (1, 1, 700000, 1, 700000, 1, 700000, 1, 700000, 200, 10000, 300, 86400, 604800, 'Initial MVP policy', now())
ON CONFLICT (revision) DO NOTHING;

INSERT INTO roles(code, description) VALUES
  ('ADMIN', 'Full platform administration'),
  ('DISPUTE_OPERATOR', 'Investigate and propose dispute resolutions'),
  ('FINANCE_OPERATOR', 'Operate money policy, reconciliation, and adjustments')
ON CONFLICT (code) DO NOTHING;
INSERT INTO platform_controls(key, outbound_money_held, reason)
VALUES ('OUTBOUND_MONEY', false, 'Initial MVP control')
ON CONFLICT (key) DO NOTHING;

CREATE UNIQUE INDEX jobs_one_engagement_per_worker_uidx
ON jobs(selected_worker_user_id)
WHERE status IN ('ASSIGNED','OVERDUE','IN_REVIEW','DISPUTED');

CREATE FUNCTION kuquest_provision_user_wallet() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE new_wallet_id uuid;
BEGIN
  INSERT INTO public.wallets(user_id) VALUES (NEW.user_id) RETURNING id INTO new_wallet_id;
  INSERT INTO public.ledger_accounts(code, type, currency, wallet_id, user_id) VALUES
    ('USER:' || NEW.user_id || ':SPENDING', 'SPENDING', 'THB', new_wallet_id, NEW.user_id),
    ('USER:' || NEW.user_id || ':EARNINGS', 'EARNINGS', 'THB', new_wallet_id, NEW.user_id),
    ('USER:' || NEW.user_id || ':JOB_HELD', 'JOB_HELD', 'THB', new_wallet_id, NEW.user_id),
    ('USER:' || NEW.user_id || ':PAYOUT_RESERVED', 'PAYOUT_RESERVED', 'THB', new_wallet_id, NEW.user_id);
  RETURN NEW;
END $$;
CREATE TRIGGER user_wallet_provision_after_insert AFTER INSERT ON "user" FOR EACH ROW EXECUTE FUNCTION kuquest_provision_user_wallet();
ALTER FUNCTION kuquest_provision_user_wallet() SECURITY DEFINER;
REVOKE ALL ON FUNCTION kuquest_provision_user_wallet() FROM PUBLIC;

INSERT INTO wallets(user_id)
SELECT u.user_id FROM "user" u WHERE lower(u.email) ~ '^[^@]+@ku[.]th$'
ON CONFLICT (user_id) DO NOTHING;
INSERT INTO ledger_accounts(code, type, currency, wallet_id, user_id)
SELECT 'USER:' || w.user_id || ':' || a.type, a.type, 'THB', w.id, w.user_id
FROM wallets w CROSS JOIN (VALUES ('SPENDING'), ('EARNINGS'), ('JOB_HELD'), ('PAYOUT_RESERVED')) AS a(type)
ON CONFLICT (code) DO NOTHING;
INSERT INTO ledger_accounts(code, type, currency) VALUES
  ('SYSTEM:PROVIDER_ASSET', 'PROVIDER_ASSET', 'THB'),
  ('SYSTEM:PAYOUT_CLEARING', 'PAYOUT_CLEARING', 'THB'),
  ('SYSTEM:PLATFORM_REVENUE', 'PLATFORM_REVENUE', 'THB'),
  ('SYSTEM:ADJUSTMENTS', 'ADJUSTMENTS', 'THB'),
  ('SYSTEM:SHORTFALL', 'SHORTFALL', 'THB')
ON CONFLICT (code) DO NOTHING;

CREATE FUNCTION kuquest_reject_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END $$;

CREATE TRIGGER wallet_status_history_immutable BEFORE UPDATE OR DELETE ON wallet_status_history FOR EACH ROW EXECUTE FUNCTION kuquest_reject_mutation();
CREATE TRIGGER job_status_history_immutable BEFORE UPDATE OR DELETE ON job_status_history FOR EACH ROW EXECUTE FUNCTION kuquest_reject_mutation();
CREATE TRIGGER job_application_status_history_immutable BEFORE UPDATE OR DELETE ON job_application_status_history FOR EACH ROW EXECUTE FUNCTION kuquest_reject_mutation();
CREATE TRIGGER work_submission_status_history_immutable BEFORE UPDATE OR DELETE ON work_submission_status_history FOR EACH ROW EXECUTE FUNCTION kuquest_reject_mutation();
CREATE TRIGGER dispute_status_history_immutable BEFORE UPDATE OR DELETE ON dispute_status_history FOR EACH ROW EXECUTE FUNCTION kuquest_reject_mutation();
CREATE TRIGGER top_up_status_history_immutable BEFORE UPDATE OR DELETE ON top_up_status_history FOR EACH ROW EXECUTE FUNCTION kuquest_reject_mutation();
CREATE TRIGGER payout_status_history_immutable BEFORE UPDATE OR DELETE ON payout_status_history FOR EACH ROW EXECUTE FUNCTION kuquest_reject_mutation();
CREATE TRIGGER provider_webhook_history_immutable BEFORE UPDATE OR DELETE ON provider_webhook_event_status_history FOR EACH ROW EXECUTE FUNCTION kuquest_reject_mutation();
CREATE TRIGGER scheduled_task_history_immutable BEFORE UPDATE OR DELETE ON scheduled_task_status_history FOR EACH ROW EXECUTE FUNCTION kuquest_reject_mutation();
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION kuquest_reject_mutation();
CREATE TRIGGER earnings_conversions_immutable BEFORE UPDATE OR DELETE ON earnings_conversions FOR EACH ROW EXECUTE FUNCTION kuquest_reject_mutation();
CREATE TRIGGER wallet_adjustments_immutable BEFORE UPDATE OR DELETE ON wallet_adjustments FOR EACH ROW EXECUTE FUNCTION kuquest_reject_mutation();
CREATE TRIGGER money_policy_revisions_immutable BEFORE UPDATE OR DELETE ON money_policy_revisions FOR EACH ROW EXECUTE FUNCTION kuquest_reject_mutation();
CREATE TRIGGER ledger_accounts_immutable BEFORE UPDATE OR DELETE ON ledger_accounts FOR EACH ROW EXECUTE FUNCTION kuquest_reject_mutation();
CREATE TRIGGER payout_cancellation_attempts_immutable BEFORE UPDATE OR DELETE ON payout_cancellation_attempts FOR EACH ROW EXECUTE FUNCTION kuquest_reject_mutation();
REVOKE ALL ON FUNCTION kuquest_reject_mutation() FROM PUBLIC;

CREATE FUNCTION kuquest_guard_resolution_approval() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.dispute_resolutions r WHERE r.id = NEW.resolution_id AND r.proposed_by_user_id = NEW.approver_user_id) THEN
    RAISE EXCEPTION 'resolution proposer cannot approve their own proposal' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dispute_resolution_approval_separation BEFORE INSERT ON dispute_resolution_approvals FOR EACH ROW EXECUTE FUNCTION kuquest_guard_resolution_approval();
REVOKE ALL ON FUNCTION kuquest_guard_resolution_approval() FROM PUBLIC;

CREATE FUNCTION kuquest_guard_ledger_transaction() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ledger transactions are immutable' USING ERRCODE = '55000'; END IF;
  IF OLD.sealed_at IS NOT NULL THEN RAISE EXCEPTION 'sealed ledger transactions are immutable' USING ERRCODE = '55000'; END IF;
  IF NEW.sealed_at IS NULL OR (to_jsonb(NEW) - 'sealed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'sealed_at') THEN
    RAISE EXCEPTION 'only sealing an unsealed ledger transaction is permitted' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_transactions_guard BEFORE UPDATE OR DELETE ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION kuquest_guard_ledger_transaction();
REVOKE ALL ON FUNCTION kuquest_guard_ledger_transaction() FROM PUBLIC;

CREATE FUNCTION kuquest_guard_ledger_posting() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'ledger postings are immutable' USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM public.ledger_transactions t WHERE t.id = NEW.transaction_id AND t.sealed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'cannot append to a sealed ledger transaction' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_postings_guard BEFORE INSERT OR UPDATE OR DELETE ON ledger_postings FOR EACH ROW EXECUTE FUNCTION kuquest_guard_ledger_posting();
REVOKE ALL ON FUNCTION kuquest_guard_ledger_posting() FROM PUBLIC;

CREATE FUNCTION kuquest_check_ledger_seal() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE posting_count bigint; currency_count bigint; balance bigint; current_sealed_at timestamptz;
BEGIN
  SELECT sealed_at INTO current_sealed_at FROM public.ledger_transactions WHERE id = NEW.id;
  IF current_sealed_at IS NULL THEN RAISE EXCEPTION 'ledger transaction must be sealed before commit' USING ERRCODE = '23514'; END IF;
  SELECT count(*), count(DISTINCT currency), coalesce(sum(amount_baht), 0)
    INTO posting_count, currency_count, balance FROM public.ledger_postings WHERE transaction_id = NEW.id;
  IF posting_count < 2 OR currency_count <> 1 OR balance <> 0 THEN
    RAISE EXCEPTION 'sealed ledger transaction must have at least two same-currency balanced postings' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_transactions_balanced_after_insert AFTER INSERT ON ledger_transactions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kuquest_check_ledger_seal();
CREATE CONSTRAINT TRIGGER ledger_transactions_balanced_after_seal AFTER UPDATE OF sealed_at ON ledger_transactions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kuquest_check_ledger_seal();
REVOKE ALL ON FUNCTION kuquest_check_ledger_seal() FROM PUBLIC;

CREATE FUNCTION kuquest_update_wallet_cache() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE account_type text; account_wallet_id uuid;
BEGIN
  SELECT type, wallet_id INTO account_type, account_wallet_id FROM public.ledger_accounts WHERE id = NEW.account_id;
  IF account_wallet_id IS NULL THEN RETURN NEW; END IF;
  UPDATE public.wallets SET
    spending_balance_baht = spending_balance_baht + CASE WHEN account_type = 'SPENDING' THEN NEW.amount_baht ELSE 0 END,
    earnings_balance_baht = earnings_balance_baht + CASE WHEN account_type = 'EARNINGS' THEN NEW.amount_baht ELSE 0 END,
    held_for_jobs_baht = held_for_jobs_baht + CASE WHEN account_type = 'JOB_HELD' THEN NEW.amount_baht ELSE 0 END,
    reserved_for_payouts_baht = reserved_for_payouts_baht + CASE WHEN account_type = 'PAYOUT_RESERVED' THEN NEW.amount_baht ELSE 0 END,
    updated_at = now()
  WHERE id = account_wallet_id;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_postings_wallet_cache_after_insert AFTER INSERT ON ledger_postings FOR EACH ROW EXECUTE FUNCTION kuquest_update_wallet_cache();
ALTER FUNCTION kuquest_update_wallet_cache() SECURITY DEFINER;
REVOKE ALL ON FUNCTION kuquest_update_wallet_cache() FROM PUBLIC;

DO $$
BEGIN
  IF to_regrole('kuquest_app') IS NOT NULL THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM kuquest_app;
    GRANT USAGE ON SCHEMA public TO kuquest_app;
    GRANT SELECT ON "user", session, account, verification, wallets,
      ledger_accounts, ledger_transactions, ledger_postings, idempotency_keys,
      earnings_conversions, wallet_activities, money_policy_revisions
      TO kuquest_app;
    GRANT SELECT(id, provider, provider_event_id, payload_hash)
      ON provider_webhook_events TO kuquest_app;
    GRANT INSERT ON "user", session, account, verification, idempotency_keys,
      ledger_transactions, ledger_postings, earnings_conversions,
      wallet_activities, provider_webhook_events TO kuquest_app;
    GRANT UPDATE ON "user", session, account, verification, idempotency_keys
      TO kuquest_app;
    GRANT UPDATE(sealed_at) ON ledger_transactions TO kuquest_app;
    -- PostgreSQL requires some UPDATE privilege for SELECT ... FOR UPDATE.
    -- The cache trigger owns balance changes; the API may only touch this timestamp.
    GRANT UPDATE(updated_at) ON wallets TO kuquest_app;
    GRANT DELETE ON session, account, verification TO kuquest_app;
  END IF;
END $$;
