ALTER TABLE "wallet_wallets" ADD CONSTRAINT "wallet_wallets_id_user_key" UNIQUE("id","user_id");--> statement-breakpoint
CREATE TABLE "wallet_funding_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"caller_scope" text NOT NULL,
	"caller_reference" text NOT NULL,
	"policy_revision_id" uuid NOT NULL,
	"total_reserved_satang" integer NOT NULL,
	"remaining_satang" integer NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_ledger_transaction_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_funding_reservations_created_ledger_transaction_id_unique" UNIQUE("created_ledger_transaction_id"),
	CONSTRAINT "wallet_funding_reservations_owner_scope_reference_key" UNIQUE("owner_user_id","caller_scope","caller_reference"),
	CONSTRAINT "wallet_funding_reservations_amounts_check" CHECK ("wallet_funding_reservations"."total_reserved_satang" > 0 AND "wallet_funding_reservations"."remaining_satang" BETWEEN 0 AND "wallet_funding_reservations"."total_reserved_satang"),
	CONSTRAINT "wallet_funding_reservations_status_check" CHECK ("wallet_funding_reservations"."status" IN ('ACTIVE', 'RELEASED', 'SETTLED')),
	CONSTRAINT "wallet_funding_reservations_completion_check" CHECK (("wallet_funding_reservations"."status" = 'ACTIVE') = ("wallet_funding_reservations"."remaining_satang" > 0))
);
--> statement-breakpoint
CREATE TABLE "wallet_funding_reservation_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"settlement_reference" text NOT NULL,
	"recipient_wallet_id" uuid NOT NULL,
	"recipient_user_id" text NOT NULL,
	"recipient_amount_satang" integer NOT NULL,
	"platform_fee_satang" integer DEFAULT 0 NOT NULL,
	"total_amount_satang" integer NOT NULL,
	"ledger_transaction_id" uuid NOT NULL,
	"idempotency_key_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_funding_reservation_settlements_ledger_transaction_id_unique" UNIQUE("ledger_transaction_id"),
	CONSTRAINT "wallet_funding_reservation_settlements_idempotency_key_id_unique" UNIQUE("idempotency_key_id"),
	CONSTRAINT "wallet_funding_settlements_reservation_reference_key" UNIQUE("reservation_id","settlement_reference"),
	CONSTRAINT "wallet_funding_settlements_amounts_check" CHECK ("wallet_funding_reservation_settlements"."recipient_amount_satang" > 0 AND "wallet_funding_reservation_settlements"."platform_fee_satang" >= 0 AND "wallet_funding_reservation_settlements"."total_amount_satang" = "wallet_funding_reservation_settlements"."recipient_amount_satang" + "wallet_funding_reservation_settlements"."platform_fee_satang")
);
--> statement-breakpoint
ALTER TABLE "wallet_ledger_transactions" DROP CONSTRAINT "wallet_ledger_transactions_event_type_check";--> statement-breakpoint
ALTER TABLE "wallet_funding_reservations" ADD CONSTRAINT "wallet_funding_reservations_owner_user_id_auth_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_funding_reservations" ADD CONSTRAINT "wallet_funding_reservations_policy_revision_id_payment_money_policy_revisions_id_fk" FOREIGN KEY ("policy_revision_id") REFERENCES "public"."payment_money_policy_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_funding_reservations" ADD CONSTRAINT "wallet_funding_reservations_created_ledger_transaction_id_wallet_ledger_transactions_id_fk" FOREIGN KEY ("created_ledger_transaction_id") REFERENCES "public"."wallet_ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_funding_reservations" ADD CONSTRAINT "wallet_funding_reservations_wallet_owner_fk" FOREIGN KEY ("wallet_id","owner_user_id") REFERENCES "public"."wallet_wallets"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_funding_reservation_settlements" ADD CONSTRAINT "wallet_funding_reservation_settlements_reservation_id_wallet_funding_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."wallet_funding_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_funding_reservation_settlements" ADD CONSTRAINT "wallet_funding_reservation_settlements_recipient_user_id_auth_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_funding_reservation_settlements" ADD CONSTRAINT "wallet_funding_reservation_settlements_ledger_transaction_id_wallet_ledger_transactions_id_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."wallet_ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_funding_reservation_settlements" ADD CONSTRAINT "wallet_funding_reservation_settlements_idempotency_key_id_wallet_idempotency_keys_id_fk" FOREIGN KEY ("idempotency_key_id") REFERENCES "public"."wallet_idempotency_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_funding_reservation_settlements" ADD CONSTRAINT "wallet_funding_settlements_recipient_owner_fk" FOREIGN KEY ("recipient_wallet_id","recipient_user_id") REFERENCES "public"."wallet_wallets"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger_transactions" ADD CONSTRAINT "wallet_ledger_transactions_event_type_check" CHECK ("wallet_ledger_transactions"."event_type" IN ('TOP_UP', 'PAYOUT', 'FUNDING_RESERVE', 'FUNDING_RELEASE', 'FUNDING_SETTLEMENT', 'ADJUSTMENT', 'EARNINGS_CONVERSION'));--> statement-breakpoint
CREATE OR REPLACE FUNCTION wallet_validate_funding_reservation_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.wallet_id IS DISTINCT FROM OLD.wallet_id
    OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    OR NEW.caller_scope IS DISTINCT FROM OLD.caller_scope
    OR NEW.caller_reference IS DISTINCT FROM OLD.caller_reference
    OR NEW.policy_revision_id IS DISTINCT FROM OLD.policy_revision_id
    OR NEW.created_ledger_transaction_id IS DISTINCT FROM OLD.created_ledger_transaction_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Funding Reservation identity and policy snapshot are immutable';
  END IF;
  IF OLD.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'completed Funding Reservations are immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER wallet_funding_reservations_update_validate
BEFORE UPDATE ON wallet_funding_reservations
FOR EACH ROW EXECUTE FUNCTION wallet_validate_funding_reservation_update();--> statement-breakpoint
CREATE TRIGGER wallet_funding_reservations_no_hard_delete
BEFORE DELETE ON wallet_funding_reservations
FOR EACH ROW EXECUTE FUNCTION wallet_reject_financial_delete();--> statement-breakpoint
CREATE OR REPLACE FUNCTION wallet_reject_funding_settlement_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Funding Reservation settlements are immutable';
END;
$$;--> statement-breakpoint
CREATE TRIGGER wallet_funding_settlements_immutable
BEFORE UPDATE OR DELETE ON wallet_funding_reservation_settlements
FOR EACH ROW EXECUTE FUNCTION wallet_reject_funding_settlement_mutation();
