CREATE TABLE "wallet_earnings_conversions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"principal_user_id" text NOT NULL,
	"amount_satang" integer NOT NULL,
	"business_reference" text NOT NULL,
	"ledger_transaction_id" uuid NOT NULL,
	"idempotency_key_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_earnings_conversions_business_reference_unique" UNIQUE("business_reference"),
	CONSTRAINT "wallet_earnings_conversions_ledger_transaction_id_unique" UNIQUE("ledger_transaction_id"),
	CONSTRAINT "wallet_earnings_conversions_idempotency_key_id_unique" UNIQUE("idempotency_key_id"),
	CONSTRAINT "wallet_earnings_conversions_amount_check" CHECK ("wallet_earnings_conversions"."amount_satang" > 0 AND "wallet_earnings_conversions"."amount_satang" <= 2000000000)
);
--> statement-breakpoint
ALTER TABLE "wallet_earnings_conversions" ADD CONSTRAINT "wallet_earnings_conversions_principal_user_id_auth_user_id_fk" FOREIGN KEY ("principal_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_earnings_conversions" ADD CONSTRAINT "wallet_earnings_conversions_ledger_transaction_id_wallet_ledger_transactions_id_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."wallet_ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_earnings_conversions" ADD CONSTRAINT "wallet_earnings_conversions_idempotency_key_id_wallet_idempotency_keys_id_fk" FOREIGN KEY ("idempotency_key_id") REFERENCES "public"."wallet_idempotency_keys"("id") ON DELETE no action ON UPDATE no action;