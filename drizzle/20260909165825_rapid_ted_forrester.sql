CREATE TABLE "wallet_dispute_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"settlement_reference" text NOT NULL,
	"recipient_wallet_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"amount_satang" integer NOT NULL,
	"ledger_transaction_id" uuid NOT NULL,
	"idempotency_key_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_dispute_settlements_ledger_transaction_id_unique" UNIQUE("ledger_transaction_id"),
	CONSTRAINT "wallet_dispute_settlements_idempotency_key_id_unique" UNIQUE("idempotency_key_id"),
	CONSTRAINT "wallet_dispute_settlements_reservation_reference_key" UNIQUE("reservation_id","settlement_reference"),
	CONSTRAINT "wallet_dispute_settlements_amount_check" CHECK ("wallet_dispute_settlements"."amount_satang" BETWEEN 1 AND 2000000000)
);
--> statement-breakpoint
ALTER TABLE "wallet_dispute_settlements" ADD CONSTRAINT "wallet_dispute_settlements_reservation_id_wallet_funding_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."wallet_funding_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_dispute_settlements" ADD CONSTRAINT "wallet_dispute_settlements_recipient_user_id_auth_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_dispute_settlements" ADD CONSTRAINT "wallet_dispute_settlements_ledger_transaction_id_wallet_ledger_transactions_id_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."wallet_ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_dispute_settlements" ADD CONSTRAINT "wallet_dispute_settlements_idempotency_key_id_wallet_idempotency_keys_id_fk" FOREIGN KEY ("idempotency_key_id") REFERENCES "public"."wallet_idempotency_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_dispute_settlements" ADD CONSTRAINT "wallet_dispute_settlements_recipient_owner_fk" FOREIGN KEY ("recipient_wallet_id","recipient_user_id") REFERENCES "public"."wallet_wallets"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wallet_dispute_settlements_reservation_idx" ON "wallet_dispute_settlements" USING btree ("reservation_id","created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION wallet_reject_dispute_settlement_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Dispute settlements are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER wallet_dispute_settlements_immutable
BEFORE UPDATE OR DELETE ON wallet_dispute_settlements
FOR EACH ROW EXECUTE FUNCTION wallet_reject_dispute_settlement_mutation();
