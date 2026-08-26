-- Existing legacy values require application-level AES-256-GCM re-encryption.
-- Abort before any DDL when the legacy tables are populated so history is not
-- deleted or left partially migrated.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "payment_payout_accounts") OR EXISTS (SELECT 1 FROM "payment_payouts") THEN
    RAISE EXCEPTION 'Cannot migrate plaintext Payout Destination secrets automatically';
  END IF;
END;
$$;--> statement-breakpoint

ALTER TABLE "payment_payout_accounts" DROP CONSTRAINT "payment_payout_accounts_recipient_type_check";--> statement-breakpoint
ALTER TABLE "payment_payout_accounts" ADD COLUMN "account_number_key_version" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_payout_accounts" ADD COLUMN "account_number_nonce" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_payout_accounts" ADD COLUMN "account_number_ciphertext" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_payout_accounts" ADD COLUMN "account_number_auth_tag" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_payout_accounts" ADD COLUMN "routing_value_key_version" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_payout_accounts" ADD COLUMN "routing_value_nonce" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_payout_accounts" ADD COLUMN "routing_value_ciphertext" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_payout_accounts" ADD COLUMN "routing_value_auth_tag" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD COLUMN "destination_account_number_key_version" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD COLUMN "destination_account_number_nonce" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD COLUMN "destination_account_number_ciphertext" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD COLUMN "destination_account_number_auth_tag" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD COLUMN "destination_routing_value_key_version" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD COLUMN "destination_routing_value_nonce" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD COLUMN "destination_routing_value_ciphertext" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD COLUMN "destination_routing_value_auth_tag" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_payout_accounts" ADD CONSTRAINT "payment_payout_accounts_id_user_key" UNIQUE("id","user_id");--> statement-breakpoint
ALTER TABLE "payment_payout_quotes" ADD CONSTRAINT "payment_payout_quotes_id_user_key" UNIQUE("id","user_id");--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD CONSTRAINT "payment_payouts_id_user_key" UNIQUE("id","user_id");--> statement-breakpoint
ALTER TABLE "payment_payout_quotes" ADD CONSTRAINT "payment_payout_quotes_account_user_fk" FOREIGN KEY ("payout_account_id","user_id") REFERENCES "public"."payment_payout_accounts"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD CONSTRAINT "payment_payouts_quote_user_fk" FOREIGN KEY ("quote_id","user_id") REFERENCES "public"."payment_payout_quotes"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD CONSTRAINT "payment_payouts_account_user_fk" FOREIGN KEY ("payout_account_id","user_id") REFERENCES "public"."payment_payout_accounts"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_payout_accounts" DROP COLUMN "account_number";--> statement-breakpoint
ALTER TABLE "payment_payout_accounts" DROP COLUMN "routing_value";--> statement-breakpoint
ALTER TABLE "payment_payouts" DROP COLUMN "destination_account_number";--> statement-breakpoint
ALTER TABLE "payment_payouts" DROP COLUMN "destination_routing_value";--> statement-breakpoint
ALTER TABLE "payment_payout_accounts" ADD CONSTRAINT "payment_payout_accounts_routing_type_check" CHECK ("payment_payout_accounts"."routing_type" IN ('BANK_ACCOUNT', 'PROMPTPAY'));--> statement-breakpoint
ALTER TABLE "payment_payout_accounts" ADD CONSTRAINT "payment_payout_accounts_recipient_type_check" CHECK ("payment_payout_accounts"."recipient_type" = 'SELF');
