-- Retire the legacy Quest state without losing historical failed-Quest rows.
-- The old Admin settlement route is no longer registered; these rows must be
-- reachable by the canonical QUEST_FAILED Dispute Case contract.
UPDATE quest
SET quest_status = 'QUEST_FAILED',
    failed_at = COALESCE(failed_at, updated_at)
WHERE quest_status = 'QUEST_DISPUTED';--> statement-breakpoint
-- Normalize legacy Proof decisions before tightening the active vocabulary.
UPDATE proof_submission
SET submission_status = 'PROOF_APPROVED'
WHERE submission_status = 'PROOF_AUTO_APPROVED';--> statement-breakpoint
UPDATE proof_submission
SET submission_status = 'PROOF_NOT_APPROVED'
WHERE submission_status = 'PROOF_REJECTED';--> statement-breakpoint
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
  ) OR EXISTS (
    SELECT 1
    FROM wallet_dispute_settlements settlement
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
    - COALESCE((
      SELECT SUM(settlement.amount_satang)
      FROM wallet_dispute_settlements settlement
      INNER JOIN wallet_ledger_transactions ledger
        ON ledger.id = settlement.ledger_transaction_id
      WHERE settlement.reservation_id = target_reservation_id
        AND ledger.correction_of_transaction_id = reservation_row.created_ledger_transaction_id
    ), 0)
    - COALESCE((SELECT SUM(operation.amount_satang) FROM wallet_funding_reservation_operations operation WHERE operation.reservation_id = target_reservation_id AND operation.operation_type = 'RELEASE'), 0)
  )::INTEGER
    INTO expected_remaining;

  IF reservation_row.total_reserved_satang <> expected_total
    OR reservation_row.remaining_satang <> expected_remaining THEN
    RAISE EXCEPTION 'Funding Reservation projection does not match its retained history';
  END IF;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER wallet_dispute_settlements_history_validate
AFTER INSERT ON wallet_dispute_settlements
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION wallet_validate_funding_reservation_child_history();
