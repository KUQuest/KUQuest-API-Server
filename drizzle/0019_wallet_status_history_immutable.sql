CREATE OR REPLACE FUNCTION wallet_reject_status_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Wallet status history is immutable';
END;
$$;--> statement-breakpoint
CREATE TRIGGER wallet_status_history_immutable
BEFORE UPDATE OR DELETE ON wallet_status_history
FOR EACH ROW EXECUTE FUNCTION wallet_reject_status_history_mutation();
