ALTER TABLE "payment_payout_quotes" DROP CONSTRAINT "payment_payout_quotes_currency_check";--> statement-breakpoint
ALTER TABLE "payment_payout_quotes" DROP CONSTRAINT "payment_payout_quotes_amount_check";--> statement-breakpoint
ALTER TABLE "payment_payouts" DROP CONSTRAINT "payment_payouts_currency_check";--> statement-breakpoint
ALTER TABLE "payment_payouts" DROP CONSTRAINT "payment_payouts_amount_check";--> statement-breakpoint
-- Keep the new Satang columns nullable during this expand step. The current
-- application writes them, but an older image still writes the legacy columns.
-- Retain legacy amount columns for expand-and-contract compatibility. A later
-- forward migration can remove them after all old application images are gone.
ALTER TABLE "payment_payouts" ALTER COLUMN "actual_fee_satang" SET DATA TYPE integer USING "actual_fee_satang"::integer;--> statement-breakpoint
ALTER TABLE "payment_payouts" ALTER COLUMN "actual_tax_satang" SET DATA TYPE integer USING "actual_tax_satang"::integer;--> statement-breakpoint
ALTER TABLE "payment_payouts" ALTER COLUMN "actual_debit_satang" SET DATA TYPE integer USING "actual_debit_satang"::integer;--> statement-breakpoint
ALTER TABLE "payment_payout_quotes" ADD COLUMN "fee_rounding_mode" text DEFAULT 'UP' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_payout_quotes" ADD COLUMN "receipt_satang" integer;--> statement-breakpoint
ALTER TABLE "payment_payout_quotes" ADD COLUMN "maximum_fee_satang" integer;--> statement-breakpoint
ALTER TABLE "payment_payout_quotes" ADD COLUMN "maximum_tax_satang" integer;--> statement-breakpoint
ALTER TABLE "payment_payout_quotes" ADD COLUMN "maximum_debit_satang" integer;--> statement-breakpoint
UPDATE "payment_payout_quotes"
SET "receipt_satang" = ("receipt_baht" * 100)::integer,
    "maximum_fee_satang" = ("maximum_fee_baht" * 100)::integer,
    "maximum_tax_satang" = ("maximum_tax_baht" * 100)::integer,
    "maximum_debit_satang" = ("maximum_debit_baht" * 100)::integer;--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD COLUMN "internal_reference" text;--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD COLUMN "provider_api_version" text;--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD COLUMN "provider_status" text;--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD COLUMN "provider_amount_satang" integer;--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD COLUMN "principal_satang" integer;--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD COLUMN "maximum_fee_satang" integer;--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD COLUMN "maximum_tax_satang" integer;--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD COLUMN "maximum_debit_satang" integer;--> statement-breakpoint
UPDATE "payment_payouts"
SET "internal_reference" = 'payout:' || "id"::text,
    "principal_satang" = ("principal_baht" * 100)::integer,
    "maximum_fee_satang" = ("maximum_fee_baht" * 100)::integer,
    "maximum_tax_satang" = ("maximum_tax_baht" * 100)::integer,
    "maximum_debit_satang" = ("maximum_debit_baht" * 100)::integer;--> statement-breakpoint
ALTER TABLE "payment_payout_quotes"
  ALTER COLUMN "receipt_baht" DROP NOT NULL,
  ALTER COLUMN "maximum_fee_baht" DROP NOT NULL,
  ALTER COLUMN "maximum_tax_baht" DROP NOT NULL,
  ALTER COLUMN "maximum_debit_baht" DROP NOT NULL,
  ALTER COLUMN "quoted_fee_satang" DROP NOT NULL,
  ALTER COLUMN "quoted_tax_satang" DROP NOT NULL,
  ALTER COLUMN "quoted_debit_satang" DROP NOT NULL,
  ALTER COLUMN "currency" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_payouts"
  ALTER COLUMN "principal_baht" DROP NOT NULL,
  ALTER COLUMN "maximum_fee_baht" DROP NOT NULL,
  ALTER COLUMN "maximum_tax_baht" DROP NOT NULL,
  ALTER COLUMN "maximum_debit_baht" DROP NOT NULL,
  ALTER COLUMN "currency" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD CONSTRAINT "payment_payouts_internal_reference_unique" UNIQUE("internal_reference");--> statement-breakpoint
ALTER TABLE "payment_payout_quotes" ADD CONSTRAINT "payment_payout_quotes_rounding_check" CHECK ("payment_payout_quotes"."fee_rounding_mode" = 'UP');--> statement-breakpoint
ALTER TABLE "payment_payout_quotes" ADD CONSTRAINT "payment_payout_quotes_amount_check" CHECK ("payment_payout_quotes"."receipt_satang" > 0 AND "payment_payout_quotes"."maximum_fee_satang" >= 0 AND "payment_payout_quotes"."maximum_tax_satang" >= 0 AND "payment_payout_quotes"."maximum_debit_satang" = "payment_payout_quotes"."receipt_satang" + "payment_payout_quotes"."maximum_fee_satang" + "payment_payout_quotes"."maximum_tax_satang");--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD CONSTRAINT "payment_payouts_actual_amount_check" CHECK (num_nonnulls("payment_payouts"."actual_fee_satang", "payment_payouts"."actual_tax_satang", "payment_payouts"."actual_debit_satang") IN (0, 3) AND ("payment_payouts"."actual_fee_satang" IS NULL OR ("payment_payouts"."actual_fee_satang" >= 0 AND "payment_payouts"."actual_tax_satang" >= 0 AND "payment_payouts"."actual_debit_satang" = "payment_payouts"."principal_satang" + "payment_payouts"."actual_fee_satang" + "payment_payouts"."actual_tax_satang" AND "payment_payouts"."actual_debit_satang" <= "payment_payouts"."maximum_debit_satang")));--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD CONSTRAINT "payment_payouts_destination_currency_check" CHECK ("payment_payouts"."destination_account_country" = 'TH' AND "payment_payouts"."destination_account_currency" = 'THB');--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD CONSTRAINT "payment_payouts_amount_check" CHECK ("payment_payouts"."principal_satang" > 0 AND "payment_payouts"."maximum_fee_satang" >= 0 AND "payment_payouts"."maximum_tax_satang" >= 0 AND "payment_payouts"."maximum_debit_satang" = "payment_payouts"."principal_satang" + "payment_payouts"."maximum_fee_satang" + "payment_payouts"."maximum_tax_satang" AND ("payment_payouts"."provider_amount_satang" IS NULL OR "payment_payouts"."provider_amount_satang" = "payment_payouts"."principal_satang"));--> statement-breakpoint
CREATE OR REPLACE FUNCTION payment_payout_quotes_no_hard_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Payout Quotes are immutable financial records';
END;
$$;--> statement-breakpoint
CREATE TRIGGER payment_payout_quotes_no_hard_delete
BEFORE DELETE ON payment_payout_quotes
FOR EACH ROW EXECUTE FUNCTION payment_payout_quotes_no_hard_delete();--> statement-breakpoint
CREATE OR REPLACE FUNCTION payment_payouts_no_hard_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Payouts are immutable financial records';
END;
$$;--> statement-breakpoint
CREATE TRIGGER payment_payouts_no_hard_delete
BEFORE DELETE ON payment_payouts
FOR EACH ROW EXECUTE FUNCTION payment_payouts_no_hard_delete();--> statement-breakpoint
CREATE OR REPLACE FUNCTION payment_payout_status_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Payout status history is immutable';
END;
$$;--> statement-breakpoint
CREATE TRIGGER payment_payout_status_history_immutable
BEFORE UPDATE OR DELETE ON payment_payout_status_history
FOR EACH ROW EXECUTE FUNCTION payment_payout_status_history_immutable();
