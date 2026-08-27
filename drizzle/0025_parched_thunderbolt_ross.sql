CREATE TABLE "payment_provider_event_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"source" text NOT NULL,
	"reason" text,
	"error" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_provider_event_history_from_status_check" CHECK ("payment_provider_event_history"."from_status" IS NULL OR "payment_provider_event_history"."from_status" IN ('RECEIVED', 'PROCESSING', 'RETRYABLE', 'PROCESSED', 'DEAD_LETTER')),
	CONSTRAINT "payment_provider_event_history_to_status_check" CHECK ("payment_provider_event_history"."to_status" IN ('RECEIVED', 'PROCESSING', 'RETRYABLE', 'PROCESSED', 'DEAD_LETTER'))
);
--> statement-breakpoint
CREATE TABLE "payment_provider_event_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"resource_type" text NOT NULL,
	"internal_reference" text,
	"provider_reference" text,
	"provider_api_version" text,
	"provider_status" text NOT NULL,
	"normalized_status" text NOT NULL,
	"provider_amount_satang" integer,
	"provider_channel_code" text,
	"provider_occurred_at" timestamp with time zone NOT NULL,
	"payload_hash" text NOT NULL,
	"raw_payload_key_version" text,
	"raw_payload_nonce" text,
	"raw_payload_ciphertext" text,
	"raw_payload_auth_tag" text,
	"raw_payload_expires_at" timestamp with time zone NOT NULL,
	"processing_status" text DEFAULT 'RECEIVED' NOT NULL,
	"attempt_count" smallint DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"last_error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_provider_event_inbox_provider_event_key" UNIQUE("provider","provider_event_id"),
	CONSTRAINT "payment_provider_event_inbox_amount_check" CHECK ("payment_provider_event_inbox"."provider_amount_satang" IS NULL OR "payment_provider_event_inbox"."provider_amount_satang" > 0),
	CONSTRAINT "payment_provider_event_inbox_attempt_check" CHECK ("payment_provider_event_inbox"."attempt_count" BETWEEN 0 AND 5),
	CONSTRAINT "payment_provider_event_inbox_normalized_status_check" CHECK ("payment_provider_event_inbox"."normalized_status" IN ('PENDING', 'PAID', 'EXPIRED', 'FAILED')),
	CONSTRAINT "payment_provider_event_inbox_processing_status_check" CHECK ("payment_provider_event_inbox"."processing_status" IN ('RECEIVED', 'PROCESSING', 'RETRYABLE', 'PROCESSED', 'DEAD_LETTER')),
	CONSTRAINT "payment_provider_event_inbox_raw_payload_check" CHECK (num_nonnulls("payment_provider_event_inbox"."raw_payload_key_version", "payment_provider_event_inbox"."raw_payload_nonce", "payment_provider_event_inbox"."raw_payload_ciphertext", "payment_provider_event_inbox"."raw_payload_auth_tag") IN (0, 4))
);
--> statement-breakpoint
ALTER TABLE "payment_provider_event_history" ADD CONSTRAINT "payment_provider_event_history_event_id_payment_provider_event_inbox_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."payment_provider_event_inbox"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_provider_event_history_event_idx" ON "payment_provider_event_history" USING btree ("event_id","occurred_at");--> statement-breakpoint
CREATE INDEX "payment_provider_event_inbox_processing_idx" ON "payment_provider_event_inbox" USING btree ("processing_status","received_at");--> statement-breakpoint
CREATE INDEX "payment_provider_event_inbox_expiry_idx" ON "payment_provider_event_inbox" USING btree ("raw_payload_expires_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION payment_provider_event_inbox_reject_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Provider event inbox records cannot be deleted';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_provider_event_inbox_no_hard_delete
BEFORE DELETE ON payment_provider_event_inbox
FOR EACH ROW EXECUTE FUNCTION payment_provider_event_inbox_reject_delete();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION payment_provider_event_history_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Provider event history is immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_provider_event_history_immutable
BEFORE UPDATE OR DELETE ON payment_provider_event_history
FOR EACH ROW EXECUTE FUNCTION payment_provider_event_history_reject_mutation();
