-- BE-172: migrate shared Auth and Admin identities to native UUID storage.
--
-- auth_user.id and auth_admin.id become native PostgreSQL UUID primary keys,
-- and every column that references them (Member/Admin foreign keys, composite
-- foreign keys, and their indexes) follows suit, matching the canonical EDR
-- (docs/db/edr/01-auth.sql). Better Auth keeps generating UUIDv4 ids in the
-- application layer (advanced.database.generateId: 'uuid'); the database now
-- stores them natively instead of as text.
--
-- Safety design (single transaction, runs inside the usual maintenance window):
--   1. Drop every foreign key that depends on an identity column, and disable
--      the triggers that make identity-bearing financial records immutable,
--      so the identity rewrite below cannot trip per-statement referential or
--      immutability checks.
--   2. Preflight: refuse to run when any reference is orphaned (points at no
--      auth_user/auth_admin row) or when kept ids would collide after the
--      case-normalizing UUID cast. Foreign keys made orphans impossible while
--      they were in force; this re-asserts that before rewriting identities.
--   3. Legacy ids that are not valid UUIDs (better-auth's pre-UUID text ids,
--      seeded test ids) receive replacement UUIDs through a temporary
--      old-to-new mapping. The mapping lives in TEMP tables dropped at
--      transaction commit — no permanent compatibility layer remains.
--   4. Rewrite auth_user.id/auth_admin.id and every referencing column from
--      the mapping, preserving uniqueness and referential integrity.
--   5. Alter the identity columns to uuid (valid legacy ids cast in place) and
--      bring the disabled immutability guards back.
--   6. Re-create every foreign key dropped in step 1.
--   7. Invalidate every existing Session: ids changed under live tokens, so
--      all Members and Admins must sign in again. Accounts (OAuth links and
--      credential hashes) are preserved via the remapped ids.

-- 1) Drop identity-dependent foreign keys (simple and composite).
ALTER TABLE "auth_account" DROP CONSTRAINT "auth_account_user_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "auth_account" DROP CONSTRAINT "auth_account_admin_id_auth_admin_id_fk";--> statement-breakpoint
ALTER TABLE "auth_session" DROP CONSTRAINT "auth_session_user_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "auth_session" DROP CONSTRAINT "auth_session_admin_id_auth_admin_id_fk";--> statement-breakpoint
ALTER TABLE "file" DROP CONSTRAINT "file_uploaded_by_user_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "payment_money_policy_revisions" DROP CONSTRAINT "payment_money_policy_revisions_authored_by_admin_id_auth_admin_id_fk";--> statement-breakpoint
ALTER TABLE "payment_payout_accounts" DROP CONSTRAINT "payment_payout_accounts_user_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "payment_payout_cancellation_attempts" DROP CONSTRAINT "payment_payout_cancellation_attempts_admin_id_auth_admin_id_fk";--> statement-breakpoint
ALTER TABLE "payment_payout_quotes" DROP CONSTRAINT "payment_payout_quotes_user_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "payment_payout_status_history" DROP CONSTRAINT "payment_payout_status_history_actor_user_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "payment_payout_status_history" DROP CONSTRAINT "payment_payout_status_history_actor_admin_id_auth_admin_id_fk";--> statement-breakpoint
ALTER TABLE "payment_payouts" DROP CONSTRAINT "payment_payouts_user_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "payment_top_up_quotes" DROP CONSTRAINT "payment_top_up_quotes_user_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "payment_top_up_status_history" DROP CONSTRAINT "payment_top_up_status_history_actor_user_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "payment_top_up_status_history" DROP CONSTRAINT "payment_top_up_status_history_actor_admin_id_auth_admin_id_fk";--> statement-breakpoint
ALTER TABLE "payment_top_ups" DROP CONSTRAINT "payment_top_ups_user_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "profile_certificate" DROP CONSTRAINT "profile_certificate_user_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "profile_portfolio_item" DROP CONSTRAINT "profile_portfolio_item_user_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "profile_work_experience" DROP CONSTRAINT "profile_work_experience_user_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "proof_submission" DROP CONSTRAINT "proof_submission_hunter_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "proof_submission" DROP CONSTRAINT "proof_submission_submitted_by_user_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "quest" DROP CONSTRAINT "quest_giver_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "quest" DROP CONSTRAINT "quest_cancelled_by_user_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "quest" DROP CONSTRAINT "quest_cancelled_by_admin_id_auth_admin_id_fk";--> statement-breakpoint
ALTER TABLE "quest" DROP CONSTRAINT "quest_hidden_by_admin_id_auth_admin_id_fk";--> statement-breakpoint
ALTER TABLE "quest_application" DROP CONSTRAINT "quest_application_hunter_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "quest_assignment" DROP CONSTRAINT "quest_assignment_hunter_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "quest_edit_history" DROP CONSTRAINT "quest_edit_history_edited_by_user_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "quest_edit_history" DROP CONSTRAINT "quest_edit_history_edited_by_admin_id_auth_admin_id_fk";--> statement-breakpoint
ALTER TABLE "quest_edit_request" DROP CONSTRAINT "quest_edit_request_requested_by_user_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "quest_edit_request_response" DROP CONSTRAINT "quest_edit_request_response_user_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "quest_team" DROP CONSTRAINT "quest_team_leader_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "quest_team_member" DROP CONSTRAINT "quest_team_member_user_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "review" DROP CONSTRAINT "review_reviewer_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "review" DROP CONSTRAINT "review_reviewee_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "wallet_activities" DROP CONSTRAINT "wallet_activities_user_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "wallet_earnings_conversions" DROP CONSTRAINT "wallet_earnings_conversions_principal_user_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "wallet_funding_reservations" DROP CONSTRAINT "wallet_funding_reservations_owner_user_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "wallet_funding_reservation_settlements" DROP CONSTRAINT "wallet_funding_reservation_settlements_recipient_user_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "wallet_idempotency_keys" DROP CONSTRAINT "wallet_idempotency_keys_principal_user_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "wallet_ledger_transactions" DROP CONSTRAINT "wallet_ledger_transactions_created_by_user_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "wallet_status_history" DROP CONSTRAINT "wallet_status_history_actor_user_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "wallet_status_history" DROP CONSTRAINT "wallet_status_history_actor_admin_id_auth_admin_id_fk";--> statement-breakpoint
ALTER TABLE "wallet_wallets" DROP CONSTRAINT "wallet_wallets_user_id_auth_user_id_fk";--> statement-breakpoint
-- The participants check compares two identity columns, so it cannot survive
-- the intermediate state where only one of them is uuid yet.
ALTER TABLE "review" DROP CONSTRAINT "review_participants_check";--> statement-breakpoint
ALTER TABLE "payment_top_ups" DROP CONSTRAINT "payment_top_ups_quote_user_fk";--> statement-breakpoint
ALTER TABLE "wallet_funding_reservations" DROP CONSTRAINT "wallet_funding_reservations_wallet_owner_fk";--> statement-breakpoint
ALTER TABLE "wallet_funding_reservation_settlements" DROP CONSTRAINT "wallet_funding_settlements_recipient_owner_fk";--> statement-breakpoint

-- 1b) Temporarily disable the triggers that make identity-bearing financial
--     records immutable, and drop the one trigger whose column list names an
--     identity column (PostgreSQL refuses to alter a column used in a trigger
--     definition, even a disabled one). The rewrite below replaces identity
--     values without touching amounts, statuses, or dates, so the invariants
--     those triggers guard are preserved; everything comes back in step 4a.
--     This DDL is transactional and rolls back with the migration if anything
--     fails.
DROP TRIGGER "wallet_wallets_owner_immutable" ON "wallet_wallets";--> statement-breakpoint
ALTER TABLE "wallet_status_history" DISABLE TRIGGER "wallet_status_history_immutable";--> statement-breakpoint
ALTER TABLE "wallet_funding_reservations" DISABLE TRIGGER "wallet_funding_reservations_update_validate";--> statement-breakpoint
ALTER TABLE "wallet_funding_reservation_settlements" DISABLE TRIGGER "wallet_funding_settlements_immutable";--> statement-breakpoint
ALTER TABLE "wallet_ledger_transactions" DISABLE TRIGGER "wallet_ledger_transactions_immutable";--> statement-breakpoint
ALTER TABLE "payment_top_up_status_history" DISABLE TRIGGER "payment_top_up_status_history_immutable";--> statement-breakpoint
ALTER TABLE "payment_money_policy_revisions" DISABLE TRIGGER "payment_money_policy_immutable";

-- 2) Preflight, then rewrite invalid legacy identity values via a temporary
--    old-to-new mapping. TEMP tables disappear at transaction commit.
DO $$
DECLARE
  uuid_pattern constant text := '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$';
  orphaned_user_references integer;
  orphaned_admin_references integer;
  colliding_kept_user_ids integer;
  colliding_kept_admin_ids integer;
  remapped_user_ids integer;
  remapped_admin_ids integer;
BEGIN
  SELECT count(*) INTO orphaned_user_references FROM (
    SELECT user_id AS identity_ref FROM auth_session WHERE user_id IS NOT NULL
    UNION ALL SELECT user_id FROM auth_account WHERE user_id IS NOT NULL
    UNION ALL SELECT uploaded_by_user_id FROM file WHERE uploaded_by_user_id IS NOT NULL
    UNION ALL SELECT user_id FROM payment_payout_accounts WHERE user_id IS NOT NULL
    UNION ALL SELECT user_id FROM payment_payout_quotes WHERE user_id IS NOT NULL
    UNION ALL SELECT actor_user_id FROM payment_payout_status_history WHERE actor_user_id IS NOT NULL
    UNION ALL SELECT user_id FROM payment_payouts WHERE user_id IS NOT NULL
    UNION ALL SELECT user_id FROM payment_top_up_quotes WHERE user_id IS NOT NULL
    UNION ALL SELECT user_id FROM payment_top_ups WHERE user_id IS NOT NULL
    UNION ALL SELECT actor_user_id FROM payment_top_up_status_history WHERE actor_user_id IS NOT NULL
    UNION ALL SELECT user_id FROM profile_certificate WHERE user_id IS NOT NULL
    UNION ALL SELECT user_id FROM profile_portfolio_item WHERE user_id IS NOT NULL
    UNION ALL SELECT user_id FROM profile_work_experience WHERE user_id IS NOT NULL
    UNION ALL SELECT hunter_id FROM proof_submission WHERE hunter_id IS NOT NULL
    UNION ALL SELECT submitted_by_user_id FROM proof_submission WHERE submitted_by_user_id IS NOT NULL
    UNION ALL SELECT giver_id FROM quest
    UNION ALL SELECT cancelled_by_user_id FROM quest WHERE cancelled_by_user_id IS NOT NULL
    UNION ALL SELECT hunter_id FROM quest_application
    UNION ALL SELECT hunter_id FROM quest_assignment
    UNION ALL SELECT edited_by_user_id FROM quest_edit_history WHERE edited_by_user_id IS NOT NULL
    UNION ALL SELECT requested_by_user_id FROM quest_edit_request
    UNION ALL SELECT user_id FROM quest_edit_request_response
    UNION ALL SELECT leader_id FROM quest_team
    UNION ALL SELECT user_id FROM quest_team_member
    UNION ALL SELECT reviewer_id FROM review
    UNION ALL SELECT reviewee_id FROM review
    UNION ALL SELECT user_id FROM wallet_activities
    UNION ALL SELECT principal_user_id FROM wallet_earnings_conversions
    UNION ALL SELECT owner_user_id FROM wallet_funding_reservations
    UNION ALL SELECT recipient_user_id FROM wallet_funding_reservation_settlements
    UNION ALL SELECT principal_user_id FROM wallet_idempotency_keys
    UNION ALL SELECT created_by_user_id FROM wallet_ledger_transactions WHERE created_by_user_id IS NOT NULL
    UNION ALL SELECT actor_user_id FROM wallet_status_history WHERE actor_user_id IS NOT NULL
    UNION ALL SELECT user_id FROM wallet_wallets
  ) AS user_references(identity_ref)
  WHERE identity_ref NOT IN (SELECT id FROM auth_user);

  IF orphaned_user_references > 0 THEN
    RAISE EXCEPTION 'auth_user identity migration preflight found % orphaned reference(s); repair them before re-running this migration', orphaned_user_references;
  END IF;

  SELECT count(*) INTO orphaned_admin_references FROM (
    SELECT admin_id AS identity_ref FROM auth_session WHERE admin_id IS NOT NULL
    UNION ALL SELECT admin_id FROM auth_account WHERE admin_id IS NOT NULL
    UNION ALL SELECT authored_by_admin_id FROM payment_money_policy_revisions WHERE authored_by_admin_id IS NOT NULL
    UNION ALL SELECT admin_id FROM payment_payout_cancellation_attempts
    UNION ALL SELECT actor_admin_id FROM payment_payout_status_history WHERE actor_admin_id IS NOT NULL
    UNION ALL SELECT actor_admin_id FROM payment_top_up_status_history WHERE actor_admin_id IS NOT NULL
    UNION ALL SELECT cancelled_by_admin_id FROM quest WHERE cancelled_by_admin_id IS NOT NULL
    UNION ALL SELECT hidden_by_admin_id FROM quest WHERE hidden_by_admin_id IS NOT NULL
    UNION ALL SELECT edited_by_admin_id FROM quest_edit_history WHERE edited_by_admin_id IS NOT NULL
    UNION ALL SELECT actor_admin_id FROM wallet_status_history WHERE actor_admin_id IS NOT NULL
  ) AS admin_references(identity_ref)
  WHERE identity_ref NOT IN (SELECT id FROM auth_admin);

  IF orphaned_admin_references > 0 THEN
    RAISE EXCEPTION 'auth_admin identity migration preflight found % orphaned reference(s); repair them before re-running this migration', orphaned_admin_references;
  END IF;

  -- Valid legacy ids are cast in place; the UUID cast normalizes letter case,
  -- so ids that differ only in case would collide on the rebuilt primary key.
  SELECT count(*) - count(DISTINCT lower(id)) INTO colliding_kept_user_ids
  FROM auth_user WHERE id ~ uuid_pattern;
  IF colliding_kept_user_ids > 0 THEN
    RAISE EXCEPTION 'auth_user identity migration preflight found % kept id(s) that collide case-insensitively', colliding_kept_user_ids;
  END IF;

  SELECT count(*) - count(DISTINCT lower(id)) INTO colliding_kept_admin_ids
  FROM auth_admin WHERE id ~ uuid_pattern;
  IF colliding_kept_admin_ids > 0 THEN
    RAISE EXCEPTION 'auth_admin identity migration preflight found % kept id(s) that collide case-insensitively', colliding_kept_admin_ids;
  END IF;

  CREATE TEMP TABLE auth_user_id_map (
    old_id text PRIMARY KEY,
    new_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid()
  ) ON COMMIT DROP;

  CREATE TEMP TABLE auth_admin_id_map (
    old_id text PRIMARY KEY,
    new_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid()
  ) ON COMMIT DROP;

  INSERT INTO auth_user_id_map (old_id)
  SELECT id FROM auth_user WHERE id !~ uuid_pattern;

  INSERT INTO auth_admin_id_map (old_id)
  SELECT id FROM auth_admin WHERE id !~ uuid_pattern;

  IF EXISTS (
    SELECT 1 FROM auth_user_id_map map
    JOIN auth_user kept
      ON CASE WHEN kept.id ~ uuid_pattern THEN kept.id::uuid END = map.new_id
  ) THEN
    RAISE EXCEPTION 'auth_user identity migration generated a replacement UUID that collides with a kept id; re-run the migration';
  END IF;

  IF EXISTS (
    SELECT 1 FROM auth_admin_id_map map
    JOIN auth_admin kept
      ON CASE WHEN kept.id ~ uuid_pattern THEN kept.id::uuid END = map.new_id
  ) THEN
    RAISE EXCEPTION 'auth_admin identity migration generated a replacement UUID that collides with a kept id; re-run the migration';
  END IF;

  SELECT count(*) INTO remapped_user_ids FROM auth_user_id_map;
  SELECT count(*) INTO remapped_admin_ids FROM auth_admin_id_map;
  RAISE NOTICE 'identity UUID migration: replacing % auth_user id(s) and % auth_admin id(s)', remapped_user_ids, remapped_admin_ids;

  UPDATE auth_user SET id = map.new_id::text
  FROM auth_user_id_map map WHERE auth_user.id = map.old_id;

  UPDATE auth_admin SET id = map.new_id::text
  FROM auth_admin_id_map map WHERE auth_admin.id = map.old_id;

  UPDATE auth_session SET user_id = map.new_id::text
  FROM auth_user_id_map map WHERE auth_session.user_id = map.old_id;
  UPDATE auth_account SET user_id = map.new_id::text
  FROM auth_user_id_map map WHERE auth_account.user_id = map.old_id;
  UPDATE file SET uploaded_by_user_id = map.new_id::text
  FROM auth_user_id_map map WHERE file.uploaded_by_user_id = map.old_id;
  UPDATE payment_payout_accounts SET user_id = map.new_id::text
  FROM auth_user_id_map map WHERE payment_payout_accounts.user_id = map.old_id;
  UPDATE payment_payout_quotes SET user_id = map.new_id::text
  FROM auth_user_id_map map WHERE payment_payout_quotes.user_id = map.old_id;
  UPDATE payment_payout_status_history SET actor_user_id = map.new_id::text
  FROM auth_user_id_map map WHERE payment_payout_status_history.actor_user_id = map.old_id;
  UPDATE payment_payouts SET user_id = map.new_id::text
  FROM auth_user_id_map map WHERE payment_payouts.user_id = map.old_id;
  UPDATE payment_top_up_quotes SET user_id = map.new_id::text
  FROM auth_user_id_map map WHERE payment_top_up_quotes.user_id = map.old_id;
  UPDATE payment_top_ups SET user_id = map.new_id::text
  FROM auth_user_id_map map WHERE payment_top_ups.user_id = map.old_id;
  UPDATE payment_top_up_status_history SET actor_user_id = map.new_id::text
  FROM auth_user_id_map map WHERE payment_top_up_status_history.actor_user_id = map.old_id;
  UPDATE profile_certificate SET user_id = map.new_id::text
  FROM auth_user_id_map map WHERE profile_certificate.user_id = map.old_id;
  UPDATE profile_portfolio_item SET user_id = map.new_id::text
  FROM auth_user_id_map map WHERE profile_portfolio_item.user_id = map.old_id;
  UPDATE profile_work_experience SET user_id = map.new_id::text
  FROM auth_user_id_map map WHERE profile_work_experience.user_id = map.old_id;
  UPDATE proof_submission SET hunter_id = map.new_id::text
  FROM auth_user_id_map map WHERE proof_submission.hunter_id = map.old_id;
  UPDATE proof_submission SET submitted_by_user_id = map.new_id::text
  FROM auth_user_id_map map WHERE proof_submission.submitted_by_user_id = map.old_id;
  UPDATE quest SET giver_id = map.new_id::text
  FROM auth_user_id_map map WHERE quest.giver_id = map.old_id;
  UPDATE quest SET cancelled_by_user_id = map.new_id::text
  FROM auth_user_id_map map WHERE quest.cancelled_by_user_id = map.old_id;
  UPDATE quest_application SET hunter_id = map.new_id::text
  FROM auth_user_id_map map WHERE quest_application.hunter_id = map.old_id;
  UPDATE quest_assignment SET hunter_id = map.new_id::text
  FROM auth_user_id_map map WHERE quest_assignment.hunter_id = map.old_id;
  UPDATE quest_edit_history SET edited_by_user_id = map.new_id::text
  FROM auth_user_id_map map WHERE quest_edit_history.edited_by_user_id = map.old_id;
  UPDATE quest_edit_request SET requested_by_user_id = map.new_id::text
  FROM auth_user_id_map map WHERE quest_edit_request.requested_by_user_id = map.old_id;
  UPDATE quest_edit_request_response SET user_id = map.new_id::text
  FROM auth_user_id_map map WHERE quest_edit_request_response.user_id = map.old_id;
  UPDATE quest_team SET leader_id = map.new_id::text
  FROM auth_user_id_map map WHERE quest_team.leader_id = map.old_id;
  UPDATE quest_team_member SET user_id = map.new_id::text
  FROM auth_user_id_map map WHERE quest_team_member.user_id = map.old_id;
  UPDATE review SET reviewer_id = map.new_id::text
  FROM auth_user_id_map map WHERE review.reviewer_id = map.old_id;
  UPDATE review SET reviewee_id = map.new_id::text
  FROM auth_user_id_map map WHERE review.reviewee_id = map.old_id;
  UPDATE wallet_activities SET user_id = map.new_id::text
  FROM auth_user_id_map map WHERE wallet_activities.user_id = map.old_id;
  UPDATE wallet_earnings_conversions SET principal_user_id = map.new_id::text
  FROM auth_user_id_map map WHERE wallet_earnings_conversions.principal_user_id = map.old_id;
  UPDATE wallet_funding_reservations SET owner_user_id = map.new_id::text
  FROM auth_user_id_map map WHERE wallet_funding_reservations.owner_user_id = map.old_id;
  UPDATE wallet_funding_reservation_settlements SET recipient_user_id = map.new_id::text
  FROM auth_user_id_map map WHERE wallet_funding_reservation_settlements.recipient_user_id = map.old_id;
  UPDATE wallet_idempotency_keys SET principal_user_id = map.new_id::text
  FROM auth_user_id_map map WHERE wallet_idempotency_keys.principal_user_id = map.old_id;
  UPDATE wallet_ledger_transactions SET created_by_user_id = map.new_id::text
  FROM auth_user_id_map map WHERE wallet_ledger_transactions.created_by_user_id = map.old_id;
  UPDATE wallet_status_history SET actor_user_id = map.new_id::text
  FROM auth_user_id_map map WHERE wallet_status_history.actor_user_id = map.old_id;
  UPDATE wallet_wallets SET user_id = map.new_id::text
  FROM auth_user_id_map map WHERE wallet_wallets.user_id = map.old_id;

  UPDATE auth_session SET admin_id = map.new_id::text
  FROM auth_admin_id_map map WHERE auth_session.admin_id = map.old_id;
  UPDATE auth_account SET admin_id = map.new_id::text
  FROM auth_admin_id_map map WHERE auth_account.admin_id = map.old_id;
  UPDATE payment_money_policy_revisions SET authored_by_admin_id = map.new_id::text
  FROM auth_admin_id_map map WHERE payment_money_policy_revisions.authored_by_admin_id = map.old_id;
  UPDATE payment_payout_cancellation_attempts SET admin_id = map.new_id::text
  FROM auth_admin_id_map map WHERE payment_payout_cancellation_attempts.admin_id = map.old_id;
  UPDATE payment_payout_status_history SET actor_admin_id = map.new_id::text
  FROM auth_admin_id_map map WHERE payment_payout_status_history.actor_admin_id = map.old_id;
  UPDATE payment_top_up_status_history SET actor_admin_id = map.new_id::text
  FROM auth_admin_id_map map WHERE payment_top_up_status_history.actor_admin_id = map.old_id;
  UPDATE quest SET cancelled_by_admin_id = map.new_id::text
  FROM auth_admin_id_map map WHERE quest.cancelled_by_admin_id = map.old_id;
  UPDATE quest SET hidden_by_admin_id = map.new_id::text
  FROM auth_admin_id_map map WHERE quest.hidden_by_admin_id = map.old_id;
  UPDATE quest_edit_history SET edited_by_admin_id = map.new_id::text
  FROM auth_admin_id_map map WHERE quest_edit_history.edited_by_admin_id = map.old_id;
  UPDATE wallet_status_history SET actor_admin_id = map.new_id::text
  FROM auth_admin_id_map map WHERE wallet_status_history.actor_admin_id = map.old_id;
END;
$$;--> statement-breakpoint

-- 3) Convert identity storage to native UUID. Valid legacy values cast in
--    place; invalid values were replaced in the step above. Indexes and
--    unique constraints over these columns are rebuilt automatically.
ALTER TABLE "auth_user" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "auth_user" ALTER COLUMN "id" TYPE uuid USING "id"::uuid;--> statement-breakpoint
ALTER TABLE "auth_user" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "auth_admin" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "auth_admin" ALTER COLUMN "id" TYPE uuid USING "id"::uuid;--> statement-breakpoint
ALTER TABLE "auth_admin" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "auth_account" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;--> statement-breakpoint
ALTER TABLE "auth_account" ALTER COLUMN "admin_id" TYPE uuid USING "admin_id"::uuid;--> statement-breakpoint
ALTER TABLE "auth_session" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;--> statement-breakpoint
ALTER TABLE "auth_session" ALTER COLUMN "admin_id" TYPE uuid USING "admin_id"::uuid;--> statement-breakpoint
ALTER TABLE "file" ALTER COLUMN "uploaded_by_user_id" TYPE uuid USING "uploaded_by_user_id"::uuid;--> statement-breakpoint
ALTER TABLE "payment_money_policy_revisions" ALTER COLUMN "authored_by_admin_id" TYPE uuid USING "authored_by_admin_id"::uuid;--> statement-breakpoint
ALTER TABLE "payment_payout_accounts" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;--> statement-breakpoint
ALTER TABLE "payment_payout_cancellation_attempts" ALTER COLUMN "admin_id" TYPE uuid USING "admin_id"::uuid;--> statement-breakpoint
ALTER TABLE "payment_payout_quotes" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;--> statement-breakpoint
ALTER TABLE "payment_payout_status_history" ALTER COLUMN "actor_user_id" TYPE uuid USING "actor_user_id"::uuid;--> statement-breakpoint
ALTER TABLE "payment_payout_status_history" ALTER COLUMN "actor_admin_id" TYPE uuid USING "actor_admin_id"::uuid;--> statement-breakpoint
ALTER TABLE "payment_payouts" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;--> statement-breakpoint
ALTER TABLE "payment_top_up_quotes" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;--> statement-breakpoint
ALTER TABLE "payment_top_up_status_history" ALTER COLUMN "actor_user_id" TYPE uuid USING "actor_user_id"::uuid;--> statement-breakpoint
ALTER TABLE "payment_top_up_status_history" ALTER COLUMN "actor_admin_id" TYPE uuid USING "actor_admin_id"::uuid;--> statement-breakpoint
ALTER TABLE "payment_top_ups" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;--> statement-breakpoint
ALTER TABLE "profile_certificate" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;--> statement-breakpoint
ALTER TABLE "profile_portfolio_item" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;--> statement-breakpoint
ALTER TABLE "profile_work_experience" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;--> statement-breakpoint
ALTER TABLE "proof_submission" ALTER COLUMN "hunter_id" TYPE uuid USING "hunter_id"::uuid;--> statement-breakpoint
ALTER TABLE "proof_submission" ALTER COLUMN "submitted_by_user_id" TYPE uuid USING "submitted_by_user_id"::uuid;--> statement-breakpoint
ALTER TABLE "quest" ALTER COLUMN "giver_id" TYPE uuid USING "giver_id"::uuid;--> statement-breakpoint
ALTER TABLE "quest" ALTER COLUMN "cancelled_by_user_id" TYPE uuid USING "cancelled_by_user_id"::uuid;--> statement-breakpoint
ALTER TABLE "quest" ALTER COLUMN "cancelled_by_admin_id" TYPE uuid USING "cancelled_by_admin_id"::uuid;--> statement-breakpoint
ALTER TABLE "quest" ALTER COLUMN "hidden_by_admin_id" TYPE uuid USING "hidden_by_admin_id"::uuid;--> statement-breakpoint
ALTER TABLE "quest_application" ALTER COLUMN "hunter_id" TYPE uuid USING "hunter_id"::uuid;--> statement-breakpoint
ALTER TABLE "quest_assignment" ALTER COLUMN "hunter_id" TYPE uuid USING "hunter_id"::uuid;--> statement-breakpoint
ALTER TABLE "quest_edit_history" ALTER COLUMN "edited_by_user_id" TYPE uuid USING "edited_by_user_id"::uuid;--> statement-breakpoint
ALTER TABLE "quest_edit_history" ALTER COLUMN "edited_by_admin_id" TYPE uuid USING "edited_by_admin_id"::uuid;--> statement-breakpoint
ALTER TABLE "quest_edit_request" ALTER COLUMN "requested_by_user_id" TYPE uuid USING "requested_by_user_id"::uuid;--> statement-breakpoint
ALTER TABLE "quest_edit_request_response" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;--> statement-breakpoint
ALTER TABLE "quest_team" ALTER COLUMN "leader_id" TYPE uuid USING "leader_id"::uuid;--> statement-breakpoint
ALTER TABLE "quest_team_member" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;--> statement-breakpoint
ALTER TABLE "review" ALTER COLUMN "reviewer_id" TYPE uuid USING "reviewer_id"::uuid;--> statement-breakpoint
ALTER TABLE "review" ALTER COLUMN "reviewee_id" TYPE uuid USING "reviewee_id"::uuid;--> statement-breakpoint
ALTER TABLE "wallet_activities" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;--> statement-breakpoint
ALTER TABLE "wallet_earnings_conversions" ALTER COLUMN "principal_user_id" TYPE uuid USING "principal_user_id"::uuid;--> statement-breakpoint
ALTER TABLE "wallet_funding_reservations" ALTER COLUMN "owner_user_id" TYPE uuid USING "owner_user_id"::uuid;--> statement-breakpoint
ALTER TABLE "wallet_funding_reservation_settlements" ALTER COLUMN "recipient_user_id" TYPE uuid USING "recipient_user_id"::uuid;--> statement-breakpoint
ALTER TABLE "wallet_idempotency_keys" ALTER COLUMN "principal_user_id" TYPE uuid USING "principal_user_id"::uuid;--> statement-breakpoint
ALTER TABLE "wallet_ledger_transactions" ALTER COLUMN "created_by_user_id" TYPE uuid USING "created_by_user_id"::uuid;--> statement-breakpoint
ALTER TABLE "wallet_status_history" ALTER COLUMN "actor_user_id" TYPE uuid USING "actor_user_id"::uuid;--> statement-breakpoint
ALTER TABLE "wallet_status_history" ALTER COLUMN "actor_admin_id" TYPE uuid USING "actor_admin_id"::uuid;--> statement-breakpoint
ALTER TABLE "wallet_wallets" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;--> statement-breakpoint

-- 4a) Bring the immutability guards removed in step 1b back.
CREATE TRIGGER "wallet_wallets_owner_immutable"
BEFORE UPDATE OF "user_id" ON "wallet_wallets"
FOR EACH ROW EXECUTE FUNCTION "wallet_reject_owner_change"();--> statement-breakpoint
ALTER TABLE "wallet_status_history" ENABLE TRIGGER "wallet_status_history_immutable";--> statement-breakpoint
ALTER TABLE "wallet_funding_reservations" ENABLE TRIGGER "wallet_funding_reservations_update_validate";--> statement-breakpoint
ALTER TABLE "wallet_funding_reservation_settlements" ENABLE TRIGGER "wallet_funding_settlements_immutable";--> statement-breakpoint
ALTER TABLE "wallet_ledger_transactions" ENABLE TRIGGER "wallet_ledger_transactions_immutable";--> statement-breakpoint
ALTER TABLE "payment_top_up_status_history" ENABLE TRIGGER "payment_top_up_status_history_immutable";--> statement-breakpoint
ALTER TABLE "payment_money_policy_revisions" ENABLE TRIGGER "payment_money_policy_immutable";--> statement-breakpoint

-- 4b) Re-create every foreign key dropped in step 1 and the review
--     participants check dropped alongside them.
ALTER TABLE "review" ADD CONSTRAINT "review_participants_check" CHECK ("reviewer_id" <> "reviewee_id");--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_admin_id_auth_admin_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_admin_id_auth_admin_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_uploaded_by_user_id_auth_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_money_policy_revisions" ADD CONSTRAINT "payment_money_policy_revisions_authored_by_admin_id_auth_admin_id_fk" FOREIGN KEY ("authored_by_admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_payout_accounts" ADD CONSTRAINT "payment_payout_accounts_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_payout_cancellation_attempts" ADD CONSTRAINT "payment_payout_cancellation_attempts_admin_id_auth_admin_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_payout_quotes" ADD CONSTRAINT "payment_payout_quotes_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_payout_status_history" ADD CONSTRAINT "payment_payout_status_history_actor_user_id_auth_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_payout_status_history" ADD CONSTRAINT "payment_payout_status_history_actor_admin_id_auth_admin_id_fk" FOREIGN KEY ("actor_admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD CONSTRAINT "payment_payouts_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_top_up_quotes" ADD CONSTRAINT "payment_top_up_quotes_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_top_up_status_history" ADD CONSTRAINT "payment_top_up_status_history_actor_user_id_auth_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_top_up_status_history" ADD CONSTRAINT "payment_top_up_status_history_actor_admin_id_auth_admin_id_fk" FOREIGN KEY ("actor_admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_top_ups" ADD CONSTRAINT "payment_top_ups_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_certificate" ADD CONSTRAINT "profile_certificate_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_portfolio_item" ADD CONSTRAINT "profile_portfolio_item_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_work_experience" ADD CONSTRAINT "profile_work_experience_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_submission" ADD CONSTRAINT "proof_submission_hunter_id_auth_user_id_fk" FOREIGN KEY ("hunter_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_submission" ADD CONSTRAINT "proof_submission_submitted_by_user_id_auth_user_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_giver_id_auth_user_id_fk" FOREIGN KEY ("giver_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_cancelled_by_user_id_auth_user_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_cancelled_by_admin_id_auth_admin_id_fk" FOREIGN KEY ("cancelled_by_admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_hidden_by_admin_id_auth_admin_id_fk" FOREIGN KEY ("hidden_by_admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_application" ADD CONSTRAINT "quest_application_hunter_id_auth_user_id_fk" FOREIGN KEY ("hunter_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_assignment" ADD CONSTRAINT "quest_assignment_hunter_id_auth_user_id_fk" FOREIGN KEY ("hunter_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_edit_history" ADD CONSTRAINT "quest_edit_history_edited_by_user_id_auth_user_id_fk" FOREIGN KEY ("edited_by_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_edit_history" ADD CONSTRAINT "quest_edit_history_edited_by_admin_id_auth_admin_id_fk" FOREIGN KEY ("edited_by_admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_edit_request" ADD CONSTRAINT "quest_edit_request_requested_by_user_id_auth_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_edit_request_response" ADD CONSTRAINT "quest_edit_request_response_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_team" ADD CONSTRAINT "quest_team_leader_id_auth_user_id_fk" FOREIGN KEY ("leader_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_team_member" ADD CONSTRAINT "quest_team_member_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_reviewer_id_auth_user_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_reviewee_id_auth_user_id_fk" FOREIGN KEY ("reviewee_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_activities" ADD CONSTRAINT "wallet_activities_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_earnings_conversions" ADD CONSTRAINT "wallet_earnings_conversions_principal_user_id_auth_user_id_fk" FOREIGN KEY ("principal_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_funding_reservations" ADD CONSTRAINT "wallet_funding_reservations_owner_user_id_auth_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_funding_reservation_settlements" ADD CONSTRAINT "wallet_funding_reservation_settlements_recipient_user_id_auth_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_idempotency_keys" ADD CONSTRAINT "wallet_idempotency_keys_principal_user_id_auth_user_id_fk" FOREIGN KEY ("principal_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger_transactions" ADD CONSTRAINT "wallet_ledger_transactions_created_by_user_id_auth_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_status_history" ADD CONSTRAINT "wallet_status_history_actor_user_id_auth_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_status_history" ADD CONSTRAINT "wallet_status_history_actor_admin_id_auth_admin_id_fk" FOREIGN KEY ("actor_admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_wallets" ADD CONSTRAINT "wallet_wallets_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_top_ups" ADD CONSTRAINT "payment_top_ups_quote_user_fk" FOREIGN KEY ("quote_id","user_id") REFERENCES "public"."payment_top_up_quotes"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_funding_reservations" ADD CONSTRAINT "wallet_funding_reservations_wallet_owner_fk" FOREIGN KEY ("wallet_id","owner_user_id") REFERENCES "public"."wallet_wallets"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_funding_reservation_settlements" ADD CONSTRAINT "wallet_funding_settlements_recipient_owner_fk" FOREIGN KEY ("recipient_wallet_id","recipient_user_id") REFERENCES "public"."wallet_wallets"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- 5) Invalidate every existing Session: identity values changed underneath
--    live tokens, so all Members and Admins must sign in again.
DELETE FROM "auth_session";
