CREATE TABLE "wallet_funding_reservation_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"operation_type" text NOT NULL,
	"operation_reference" text NOT NULL,
	"amount_satang" integer NOT NULL,
	"resulting_total_reserved_satang" integer NOT NULL,
	"resulting_remaining_satang" integer NOT NULL,
	"resulting_status" text NOT NULL,
	"ledger_transaction_id" uuid NOT NULL,
	"idempotency_key_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_funding_reservation_operations_ledger_transaction_id_unique" UNIQUE("ledger_transaction_id"),
	CONSTRAINT "wallet_funding_reservation_operations_idempotency_key_id_unique" UNIQUE("idempotency_key_id"),
	CONSTRAINT "wallet_funding_operations_reservation_reference_key" UNIQUE("reservation_id","operation_reference"),
	CONSTRAINT "wallet_funding_operations_type_check" CHECK ("wallet_funding_reservation_operations"."operation_type" IN ('RESERVE', 'INCREASE', 'RELEASE')),
	CONSTRAINT "wallet_funding_operations_amounts_check" CHECK ("wallet_funding_reservation_operations"."amount_satang" BETWEEN 1 AND 2000000000 AND "wallet_funding_reservation_operations"."resulting_total_reserved_satang" BETWEEN 1 AND 2000000000 AND "wallet_funding_reservation_operations"."resulting_remaining_satang" BETWEEN 0 AND "wallet_funding_reservation_operations"."resulting_total_reserved_satang"),
	CONSTRAINT "wallet_funding_operations_status_check" CHECK ("wallet_funding_reservation_operations"."resulting_status" IN ('ACTIVE', 'RELEASED', 'SETTLED') AND ("wallet_funding_reservation_operations"."resulting_status" = 'ACTIVE') = ("wallet_funding_reservation_operations"."resulting_remaining_satang" > 0))
);
--> statement-breakpoint
ALTER TABLE "wallet_funding_reservations" DROP CONSTRAINT "wallet_funding_reservations_amounts_check";--> statement-breakpoint
ALTER TABLE "wallet_funding_reservation_operations" ADD CONSTRAINT "wallet_funding_reservation_operations_reservation_id_wallet_funding_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."wallet_funding_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_funding_reservation_operations" ADD CONSTRAINT "wallet_funding_reservation_operations_ledger_transaction_id_wallet_ledger_transactions_id_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."wallet_ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_funding_reservation_operations" ADD CONSTRAINT "wallet_funding_reservation_operations_idempotency_key_id_wallet_idempotency_keys_id_fk" FOREIGN KEY ("idempotency_key_id") REFERENCES "public"."wallet_idempotency_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_funding_reservations" ADD CONSTRAINT "wallet_funding_reservations_amounts_check" CHECK ("wallet_funding_reservations"."total_reserved_satang" BETWEEN 1 AND 2000000000 AND "wallet_funding_reservations"."remaining_satang" BETWEEN 0 AND "wallet_funding_reservations"."total_reserved_satang");
--> statement-breakpoint
DROP TRIGGER wallet_funding_reservations_update_validate ON wallet_funding_reservations;
DROP FUNCTION wallet_validate_funding_reservation_update();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION wallet_validate_funding_reservation_integrity_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.wallet_id IS DISTINCT FROM OLD.wallet_id
    OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    OR NEW.caller_scope IS DISTINCT FROM OLD.caller_scope
    OR NEW.caller_reference IS DISTINCT FROM OLD.caller_reference
    OR NEW.policy_revision_id IS DISTINCT FROM OLD.policy_revision_id
    OR NEW.created_ledger_transaction_id IS DISTINCT FROM OLD.created_ledger_transaction_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Funding Reservation identity and policy snapshot are immutable';
  END IF;
  IF OLD.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'completed Funding Reservations are immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER wallet_funding_reservations_update_validate
BEFORE UPDATE ON wallet_funding_reservations
FOR EACH ROW EXECUTE FUNCTION wallet_validate_funding_reservation_integrity_update();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION wallet_reject_funding_reservation_operation_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Funding Reservation operations are immutable';
END;
$$;--> statement-breakpoint
CREATE TRIGGER wallet_funding_reservation_operations_immutable
BEFORE UPDATE OR DELETE ON wallet_funding_reservation_operations
FOR EACH ROW EXECUTE FUNCTION wallet_reject_funding_reservation_operation_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION wallet_assert_funding_reservation_history(target_reservation_id UUID) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  reservation_row RECORD;
  expected_total INTEGER;
  expected_remaining INTEGER;
BEGIN
  SELECT * INTO reservation_row
  FROM wallet_funding_reservations
  WHERE id = target_reservation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Funding Reservation history refers to a missing reservation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM wallet_funding_reservation_operations operation
    INNER JOIN payment_money_policy_revisions policy
      ON policy.id = reservation_row.policy_revision_id
    WHERE operation.reservation_id = target_reservation_id
      AND operation.operation_type IN ('RESERVE', 'INCREASE')
      AND (
        operation.amount_satang < policy.minimum_funding_reservation_satang
        OR operation.amount_satang > policy.maximum_funding_reservation_satang
      )
  ) THEN
    RAISE EXCEPTION 'Funding Reservation operation exceeds its snapshotted Money Policy';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM wallet_funding_reservation_operations operation
    INNER JOIN wallet_ledger_transactions ledger
      ON ledger.id = operation.ledger_transaction_id
    WHERE operation.reservation_id = target_reservation_id
      AND ledger.sealed_at IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM wallet_funding_reservation_settlements settlement
    INNER JOIN wallet_ledger_transactions ledger
      ON ledger.id = settlement.ledger_transaction_id
    WHERE settlement.reservation_id = target_reservation_id
      AND ledger.sealed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Funding Reservation history must reference sealed ledger transactions';
  END IF;

  SELECT COALESCE(SUM(operation.amount_satang) FILTER (WHERE operation.operation_type IN ('RESERVE', 'INCREASE')), 0)::INTEGER
    INTO expected_total
  FROM wallet_funding_reservation_operations operation
  WHERE operation.reservation_id = target_reservation_id;

  SELECT (
    expected_total
    - COALESCE((SELECT SUM(settlement.total_amount_satang) FROM wallet_funding_reservation_settlements settlement WHERE settlement.reservation_id = target_reservation_id), 0)
    - COALESCE((SELECT SUM(operation.amount_satang) FROM wallet_funding_reservation_operations operation WHERE operation.reservation_id = target_reservation_id AND operation.operation_type = 'RELEASE'), 0)
  )::INTEGER
    INTO expected_remaining;

  IF reservation_row.total_reserved_satang <> expected_total
    OR reservation_row.remaining_satang <> expected_remaining THEN
    RAISE EXCEPTION 'Funding Reservation projection does not match its retained history';
  END IF;
  IF reservation_row.status = 'RELEASED' AND NOT EXISTS (
    SELECT 1
    FROM wallet_funding_reservation_operations operation
    WHERE operation.reservation_id = target_reservation_id
      AND operation.operation_type = 'RELEASE'
  ) THEN
    RAISE EXCEPTION 'Released Funding Reservations require a retained release operation';
  END IF;
  IF reservation_row.status = 'SETTLED' AND NOT EXISTS (
    SELECT 1
    FROM wallet_funding_reservation_settlements settlement
    WHERE settlement.reservation_id = target_reservation_id
  ) THEN
    RAISE EXCEPTION 'Settled Funding Reservations require a retained settlement';
  END IF;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION wallet_validate_funding_reservation_parent_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM wallet_assert_funding_reservation_history(NEW.id);
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION wallet_validate_funding_reservation_child_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM wallet_assert_funding_reservation_history(NEW.reservation_id);
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER wallet_funding_reservations_history_validate
AFTER INSERT OR UPDATE ON wallet_funding_reservations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION wallet_validate_funding_reservation_parent_history();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER wallet_funding_reservation_operations_history_validate
AFTER INSERT ON wallet_funding_reservation_operations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION wallet_validate_funding_reservation_child_history();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER wallet_funding_reservation_settlements_history_validate
AFTER INSERT ON wallet_funding_reservation_settlements
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION wallet_validate_funding_reservation_child_history();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION wallet_assert_wallet_projection(target_wallet_id UUID) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  expected_spending INTEGER;
  expected_earnings INTEGER;
  expected_funding_reserved INTEGER;
  expected_payout_reserved INTEGER;
  wallet_row RECORD;
BEGIN
  SELECT * INTO wallet_row
  FROM wallet_wallets
  WHERE id = target_wallet_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet projection refers to a missing Wallet';
  END IF;

  SELECT
    COALESCE(SUM(posting.amount_satang) FILTER (WHERE account.type = 'SPENDING'), 0)::INTEGER,
    COALESCE(SUM(posting.amount_satang) FILTER (WHERE account.type = 'EARNINGS'), 0)::INTEGER,
    COALESCE(SUM(posting.amount_satang) FILTER (WHERE account.type = 'FUNDING_RESERVED'), 0)::INTEGER,
    COALESCE(SUM(posting.amount_satang) FILTER (WHERE account.type = 'RESERVED_FOR_PAYOUTS'), 0)::INTEGER
  INTO expected_spending, expected_earnings, expected_funding_reserved, expected_payout_reserved
  FROM wallet_ledger_accounts account
  INNER JOIN wallet_ledger_postings posting ON posting.account_id = account.id
  INNER JOIN wallet_ledger_transactions ledger ON ledger.id = posting.transaction_id
  WHERE account.wallet_id = target_wallet_id
    AND ledger.sealed_at IS NOT NULL;

  IF wallet_row.spending_balance_satang <> expected_spending
    OR wallet_row.earnings_balance_satang <> expected_earnings
    OR wallet_row.funding_reserved_satang <> expected_funding_reserved
    OR wallet_row.reserved_for_payouts_satang <> expected_payout_reserved THEN
    RAISE EXCEPTION 'Wallet projection does not match its sealed ledger';
  END IF;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION wallet_validate_projection_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM wallet_assert_wallet_projection(NEW.id);
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER wallet_wallets_projection_validate
AFTER INSERT OR UPDATE OF spending_balance_satang, earnings_balance_satang, funding_reserved_satang, reserved_for_payouts_satang ON wallet_wallets
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION wallet_validate_projection_update();--> statement-breakpoint
CREATE OR REPLACE FUNCTION wallet_validate_ledger_projection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  affected_wallet_id UUID;
BEGIN
  IF NEW.sealed_at IS NULL THEN
    RETURN NEW;
  END IF;
  FOR affected_wallet_id IN
    SELECT DISTINCT account.wallet_id
    FROM wallet_ledger_postings posting
    INNER JOIN wallet_ledger_accounts account ON account.id = posting.account_id
    WHERE posting.transaction_id = NEW.id
      AND account.wallet_id IS NOT NULL
  LOOP
    PERFORM wallet_assert_wallet_projection(affected_wallet_id);
  END LOOP;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER wallet_ledger_projection_validate
AFTER INSERT OR UPDATE OF sealed_at ON wallet_ledger_transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION wallet_validate_ledger_projection();
