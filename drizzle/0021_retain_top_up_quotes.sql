CREATE OR REPLACE FUNCTION payment_top_up_quote_reject_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Top-up Quote records cannot be deleted';
END;
$$;--> statement-breakpoint
CREATE TRIGGER payment_top_up_quotes_no_hard_delete
BEFORE DELETE ON payment_top_up_quotes
FOR EACH ROW EXECUTE FUNCTION payment_top_up_quote_reject_delete();
