DROP TRIGGER IF EXISTS ledger_accounts_immutable ON ledger_accounts;
CREATE TRIGGER ledger_accounts_immutable
BEFORE UPDATE OR DELETE ON ledger_accounts
FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

ALTER TABLE provider_webhook_inbox
  ADD COLUMN IF NOT EXISTS payload_hash text;

UPDATE provider_webhook_inbox
SET payload_hash = event_key
WHERE payload_hash IS NULL;

ALTER TABLE provider_webhook_inbox
  ALTER COLUMN payload_hash SET NOT NULL;

-- Early development rows encoded JSON as a JSONB string. Normalize them so
-- future idempotent replays read an object and new writes use ::text::jsonb.
UPDATE idempotency_records
SET response_body = (response_body #>> '{}')::jsonb
WHERE jsonb_typeof(response_body) = 'string';
