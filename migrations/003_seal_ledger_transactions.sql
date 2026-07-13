ALTER TABLE ledger_transactions
  ADD COLUMN IF NOT EXISTS creation_db_txid bigint NOT NULL DEFAULT txid_current();

CREATE OR REPLACE FUNCTION reject_posting_append_to_committed_transaction()
RETURNS trigger AS $$
DECLARE
  parent_creation_db_txid bigint;
BEGIN
  SELECT creation_db_txid
    INTO parent_creation_db_txid
    FROM ledger_transactions
    WHERE id = NEW.transaction_id;

  IF parent_creation_db_txid IS NULL OR parent_creation_db_txid <> txid_current() THEN
    RAISE EXCEPTION 'cannot append postings to a committed ledger transaction';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_postings_no_late_append ON ledger_postings;
CREATE TRIGGER ledger_postings_no_late_append
BEFORE INSERT ON ledger_postings
FOR EACH ROW EXECUTE FUNCTION reject_posting_append_to_committed_transaction();
