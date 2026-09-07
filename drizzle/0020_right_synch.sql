ALTER TABLE "payment_top_up_quotes" DROP CONSTRAINT "payment_top_up_quotes_currency_check";--> statement-breakpoint
ALTER TABLE "payment_top_up_quotes" DROP CONSTRAINT "payment_top_up_quotes_amount_check";--> statement-breakpoint
ALTER TABLE "payment_top_ups" DROP CONSTRAINT "payment_top_ups_currency_check";--> statement-breakpoint
ALTER TABLE "payment_top_ups" DROP CONSTRAINT "payment_top_ups_amount_check";--> statement-breakpoint

ALTER TABLE "payment_top_up_quotes" RENAME COLUMN "credit_baht" TO "credit_satang";--> statement-breakpoint
ALTER TABLE "payment_top_up_quotes" RENAME COLUMN "charged_fee_baht" TO "charged_fee_satang";--> statement-breakpoint
ALTER TABLE "payment_top_up_quotes" RENAME COLUMN "charged_tax_baht" TO "charged_tax_satang";--> statement-breakpoint
ALTER TABLE "payment_top_up_quotes" RENAME COLUMN "payment_total_baht" TO "payment_total_satang";--> statement-breakpoint
ALTER TABLE "payment_top_ups" RENAME COLUMN "credit_baht" TO "credit_satang";--> statement-breakpoint
ALTER TABLE "payment_top_ups" RENAME COLUMN "charged_fee_baht" TO "charged_fee_satang";--> statement-breakpoint
ALTER TABLE "payment_top_ups" RENAME COLUMN "charged_tax_baht" TO "charged_tax_satang";--> statement-breakpoint
ALTER TABLE "payment_top_ups" RENAME COLUMN "payment_total_baht" TO "payment_total_satang";--> statement-breakpoint

ALTER TABLE "payment_top_up_quotes" ALTER COLUMN "credit_satang" TYPE integer USING ("credit_satang" * 100)::integer;--> statement-breakpoint
ALTER TABLE "payment_top_up_quotes" ALTER COLUMN "charged_fee_satang" TYPE integer USING ("charged_fee_satang" * 100)::integer;--> statement-breakpoint
ALTER TABLE "payment_top_up_quotes" ALTER COLUMN "charged_tax_satang" TYPE integer USING ("charged_tax_satang" * 100)::integer;--> statement-breakpoint
ALTER TABLE "payment_top_up_quotes" ALTER COLUMN "payment_total_satang" TYPE integer USING ("payment_total_satang" * 100)::integer;--> statement-breakpoint
ALTER TABLE "payment_top_ups" ALTER COLUMN "credit_satang" TYPE integer USING ("credit_satang" * 100)::integer;--> statement-breakpoint
ALTER TABLE "payment_top_ups" ALTER COLUMN "charged_fee_satang" TYPE integer USING ("charged_fee_satang" * 100)::integer;--> statement-breakpoint
ALTER TABLE "payment_top_ups" ALTER COLUMN "charged_tax_satang" TYPE integer USING ("charged_tax_satang" * 100)::integer;--> statement-breakpoint
ALTER TABLE "payment_top_ups" ALTER COLUMN "payment_total_satang" TYPE integer USING ("payment_total_satang" * 100)::integer;--> statement-breakpoint
ALTER TABLE "payment_top_up_quotes" ALTER COLUMN "provider_fee_satang" TYPE integer USING "provider_fee_satang"::integer;--> statement-breakpoint
ALTER TABLE "payment_top_up_quotes" ALTER COLUMN "provider_tax_satang" TYPE integer USING "provider_tax_satang"::integer;--> statement-breakpoint
ALTER TABLE "payment_top_up_quotes" ALTER COLUMN "provider_total_satang" TYPE integer USING "provider_total_satang"::integer;--> statement-breakpoint
ALTER TABLE "payment_top_ups" ALTER COLUMN "provider_fee_satang" TYPE integer USING "provider_fee_satang"::integer;--> statement-breakpoint
ALTER TABLE "payment_top_ups" ALTER COLUMN "provider_tax_satang" TYPE integer USING "provider_tax_satang"::integer;--> statement-breakpoint
ALTER TABLE "payment_top_ups" ALTER COLUMN "provider_total_satang" TYPE integer USING "provider_total_satang"::integer;--> statement-breakpoint

ALTER TABLE "payment_top_up_quotes" DROP COLUMN "currency";--> statement-breakpoint
ALTER TABLE "payment_top_ups" DROP COLUMN "currency";--> statement-breakpoint
ALTER TABLE "payment_top_up_quotes" ADD COLUMN "fee_rounding_mode" text DEFAULT 'UP' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_top_ups" ADD COLUMN "provider_api_version" text;--> statement-breakpoint
ALTER TABLE "payment_top_ups" ADD COLUMN "provider_status" text;--> statement-breakpoint
ALTER TABLE "payment_top_ups" ADD COLUMN "provider_amount_satang" integer;--> statement-breakpoint
ALTER TABLE "payment_top_ups" ADD COLUMN "provider_channel_code" text;--> statement-breakpoint

UPDATE "payment_top_up_quotes"
SET "provider_total_satang" = "credit_satang" + "provider_fee_satang" + "provider_tax_satang";--> statement-breakpoint
UPDATE "payment_top_ups"
SET "provider_total_satang" = "credit_satang" + "provider_fee_satang" + "provider_tax_satang";--> statement-breakpoint

ALTER TABLE "payment_top_up_quotes" ADD CONSTRAINT "payment_top_up_quotes_id_user_key" UNIQUE("id", "user_id");--> statement-breakpoint
ALTER TABLE "payment_top_ups" ADD CONSTRAINT "payment_top_ups_id_user_key" UNIQUE("id", "user_id");--> statement-breakpoint
ALTER TABLE "payment_top_up_quotes" ADD CONSTRAINT "payment_top_up_quotes_rounding_check" CHECK ("fee_rounding_mode" = 'UP');--> statement-breakpoint
ALTER TABLE "payment_top_up_quotes" ADD CONSTRAINT "payment_top_up_quotes_amount_check" CHECK ("credit_satang" > 0 AND "charged_fee_satang" >= 0 AND "charged_tax_satang" >= 0 AND "payment_total_satang" = "credit_satang" + "charged_fee_satang" + "charged_tax_satang" AND "provider_fee_satang" >= 0 AND "provider_tax_satang" >= 0 AND "provider_total_satang" = "credit_satang" + "provider_fee_satang" + "provider_tax_satang");--> statement-breakpoint
ALTER TABLE "payment_top_ups" ADD CONSTRAINT "payment_top_ups_amount_check" CHECK ("credit_satang" > 0 AND "charged_fee_satang" >= 0 AND "charged_tax_satang" >= 0 AND "payment_total_satang" = "credit_satang" + "charged_fee_satang" + "charged_tax_satang" AND "provider_fee_satang" >= 0 AND "provider_tax_satang" >= 0 AND "provider_total_satang" = "credit_satang" + "provider_fee_satang" + "provider_tax_satang" AND ("provider_amount_satang" IS NULL OR "provider_amount_satang" = "payment_total_satang"));--> statement-breakpoint
ALTER TABLE "payment_top_ups" ADD CONSTRAINT "payment_top_ups_quote_user_fk" FOREIGN KEY ("quote_id", "user_id") REFERENCES "payment_top_up_quotes"("id", "user_id");--> statement-breakpoint

CREATE OR REPLACE FUNCTION payment_top_up_status_history_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Top-up status history is immutable';
END;
$$;--> statement-breakpoint
CREATE TRIGGER payment_top_up_status_history_immutable
BEFORE UPDATE OR DELETE ON payment_top_up_status_history
FOR EACH ROW EXECUTE FUNCTION payment_top_up_status_history_reject_mutation();--> statement-breakpoint
CREATE OR REPLACE FUNCTION payment_top_up_reject_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Top-up records cannot be deleted';
END;
$$;--> statement-breakpoint
CREATE TRIGGER payment_top_ups_no_hard_delete
BEFORE DELETE ON payment_top_ups
FOR EACH ROW EXECUTE FUNCTION payment_top_up_reject_delete();
