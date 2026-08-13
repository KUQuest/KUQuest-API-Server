CREATE TABLE "payment_money_policy_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision" integer NOT NULL,
	"minimum_top_up_satang" integer NOT NULL,
	"maximum_top_up_satang" integer NOT NULL,
	"minimum_funding_reservation_satang" integer NOT NULL,
	"maximum_funding_reservation_satang" integer NOT NULL,
	"minimum_earnings_conversion_satang" integer NOT NULL,
	"maximum_earnings_conversion_satang" integer NOT NULL,
	"minimum_payout_satang" integer NOT NULL,
	"maximum_payout_satang" integer NOT NULL,
	"platform_fee_bps" integer NOT NULL,
	"fee_rounding_mode" text DEFAULT 'UP' NOT NULL,
	"top_up_provider_fee_satang" integer DEFAULT 0 NOT NULL,
	"top_up_provider_tax_bps" integer DEFAULT 0 NOT NULL,
	"payout_provider_fee_satang" integer DEFAULT 0 NOT NULL,
	"payout_provider_tax_bps" integer DEFAULT 0 NOT NULL,
	"quote_lifetime_seconds" integer NOT NULL,
	"authored_by_admin_id" text,
	"reason" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_money_policy_revisions_revision_unique" UNIQUE("revision"),
	CONSTRAINT "payment_money_policy_amounts_check" CHECK ("payment_money_policy_revisions"."minimum_top_up_satang" > 0 AND "payment_money_policy_revisions"."maximum_top_up_satang" >= "payment_money_policy_revisions"."minimum_top_up_satang" AND "payment_money_policy_revisions"."minimum_funding_reservation_satang" > 0 AND "payment_money_policy_revisions"."maximum_funding_reservation_satang" >= "payment_money_policy_revisions"."minimum_funding_reservation_satang" AND "payment_money_policy_revisions"."minimum_earnings_conversion_satang" > 0 AND "payment_money_policy_revisions"."maximum_earnings_conversion_satang" >= "payment_money_policy_revisions"."minimum_earnings_conversion_satang" AND "payment_money_policy_revisions"."minimum_payout_satang" > 0 AND "payment_money_policy_revisions"."maximum_payout_satang" >= "payment_money_policy_revisions"."minimum_payout_satang"),
	CONSTRAINT "payment_money_policy_rates_check" CHECK ("payment_money_policy_revisions"."platform_fee_bps" BETWEEN 0 AND 10000 AND "payment_money_policy_revisions"."top_up_provider_fee_satang" >= 0 AND "payment_money_policy_revisions"."top_up_provider_tax_bps" BETWEEN 0 AND 10000 AND "payment_money_policy_revisions"."payout_provider_fee_satang" >= 0 AND "payment_money_policy_revisions"."payout_provider_tax_bps" BETWEEN 0 AND 10000),
	CONSTRAINT "payment_money_policy_rounding_check" CHECK ("payment_money_policy_revisions"."fee_rounding_mode" = 'UP'),
	CONSTRAINT "payment_money_policy_windows_check" CHECK ("payment_money_policy_revisions"."quote_lifetime_seconds" > 0),
	CONSTRAINT "payment_money_policy_effective_check" CHECK ("payment_money_policy_revisions"."effective_until" IS NULL OR "payment_money_policy_revisions"."effective_until" > "payment_money_policy_revisions"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "wallet_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ledger_transaction_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"activity_status" text NOT NULL,
	"spending_delta_satang" integer DEFAULT 0 NOT NULL,
	"earnings_delta_satang" integer DEFAULT 0 NOT NULL,
	"funding_reserved_delta_satang" integer DEFAULT 0 NOT NULL,
	"payout_reserved_delta_satang" integer DEFAULT 0 NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_activities_transaction_user_key" UNIQUE("ledger_transaction_id","user_id"),
	CONSTRAINT "wallet_activities_type_check" CHECK ("wallet_activities"."type" IN ('TOP_UP', 'SPEND', 'EARN', 'HOLD', 'RELEASE')),
	CONSTRAINT "wallet_activities_status_check" CHECK ("wallet_activities"."activity_status" IN ('PENDING', 'COMPLETED', 'FAILED'))
);
--> statement-breakpoint
CREATE TABLE "wallet_idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"principal_user_id" text NOT NULL,
	"operation_scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"processing_status" text DEFAULT 'PROCESSING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "wallet_idempotency_keys_principal_scope_key" UNIQUE("principal_user_id","operation_scope","key"),
	CONSTRAINT "wallet_idempotency_keys_processing_status_check" CHECK ("wallet_idempotency_keys"."processing_status" IN ('PROCESSING', 'COMPLETED')),
	CONSTRAINT "wallet_idempotency_keys_completion_check" CHECK (("wallet_idempotency_keys"."processing_status" = 'COMPLETED') = ("wallet_idempotency_keys"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "wallet_ledger_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"type" text NOT NULL,
	"wallet_id" uuid,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_ledger_accounts_code_unique" UNIQUE("code"),
	CONSTRAINT "wallet_ledger_accounts_type_check" CHECK ("wallet_ledger_accounts"."type" IN ('SPENDING', 'EARNINGS', 'FUNDING_RESERVED', 'RESERVED_FOR_PAYOUTS', 'PLATFORM_REVENUE', 'PLATFORM_SUSPENSE')),
	CONSTRAINT "wallet_ledger_accounts_owner_check" CHECK (("wallet_ledger_accounts"."wallet_id" IS NULL) = ("wallet_ledger_accounts"."user_id" IS NULL)),
	CONSTRAINT "wallet_ledger_accounts_platform_check" CHECK (("wallet_ledger_accounts"."wallet_id" IS NULL) = ("wallet_ledger_accounts"."type" IN ('PLATFORM_REVENUE', 'PLATFORM_SUSPENSE')))
);
--> statement-breakpoint
CREATE TABLE "wallet_ledger_postings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"amount_satang" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_ledger_postings_amount_check" CHECK ("wallet_ledger_postings"."amount_satang" <> 0 AND "wallet_ledger_postings"."amount_satang" BETWEEN -2000000000 AND 2000000000)
);
--> statement-breakpoint
CREATE TABLE "wallet_ledger_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_reference" text NOT NULL,
	"event_type" text NOT NULL,
	"idempotency_key_id" uuid,
	"correction_of_transaction_id" uuid,
	"created_by_user_id" text,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sealed_at" timestamp with time zone,
	CONSTRAINT "wallet_ledger_transactions_business_reference_unique" UNIQUE("business_reference"),
	CONSTRAINT "wallet_ledger_transactions_idempotency_key_id_unique" UNIQUE("idempotency_key_id"),
	CONSTRAINT "wallet_ledger_transactions_event_type_check" CHECK ("wallet_ledger_transactions"."event_type" IN ('TOP_UP', 'PAYOUT', 'FUNDING_RESERVE', 'FUNDING_RELEASE', 'ADJUSTMENT', 'EARNINGS_CONVERSION'))
);
--> statement-breakpoint
CREATE TABLE "wallet_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_user_id" text,
	"actor_admin_id" text,
	"reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_status_history_from_check" CHECK ("wallet_status_history"."from_status" IS NULL OR "wallet_status_history"."from_status" IN ('ACTIVE', 'FROZEN', 'SUSPENDED', 'CLOSED')),
	CONSTRAINT "wallet_status_history_to_check" CHECK ("wallet_status_history"."to_status" IN ('ACTIVE', 'FROZEN', 'SUSPENDED', 'CLOSED')),
	CONSTRAINT "wallet_status_history_actor_check" CHECK (num_nonnulls("wallet_status_history"."actor_user_id", "wallet_status_history"."actor_admin_id") <= 1)
);
--> statement-breakpoint
CREATE TABLE "wallet_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"spending_balance_satang" integer DEFAULT 0 NOT NULL,
	"earnings_balance_satang" integer DEFAULT 0 NOT NULL,
	"funding_reserved_satang" integer DEFAULT 0 NOT NULL,
	"reserved_for_payouts_satang" integer DEFAULT 0 NOT NULL,
	"wallet_status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_wallets_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "wallet_wallets_status_check" CHECK ("wallet_wallets"."wallet_status" IN ('ACTIVE', 'FROZEN', 'SUSPENDED', 'CLOSED')),
	CONSTRAINT "wallet_wallets_balances_check" CHECK ("wallet_wallets"."spending_balance_satang" >= 0 AND "wallet_wallets"."earnings_balance_satang" >= 0 AND "wallet_wallets"."funding_reserved_satang" >= 0 AND "wallet_wallets"."reserved_for_payouts_satang" >= 0),
	CONSTRAINT "wallet_wallets_capacity_check" CHECK ("wallet_wallets"."spending_balance_satang" + "wallet_wallets"."earnings_balance_satang" + "wallet_wallets"."funding_reserved_satang" + "wallet_wallets"."reserved_for_payouts_satang" <= 2000000000)
);
--> statement-breakpoint
ALTER TABLE "payment_money_policy_revisions" ADD CONSTRAINT "payment_money_policy_revisions_authored_by_admin_id_auth_admin_id_fk" FOREIGN KEY ("authored_by_admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_activities" ADD CONSTRAINT "wallet_activities_ledger_transaction_id_wallet_ledger_transactions_id_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."wallet_ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_activities" ADD CONSTRAINT "wallet_activities_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_idempotency_keys" ADD CONSTRAINT "wallet_idempotency_keys_principal_user_id_auth_user_id_fk" FOREIGN KEY ("principal_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger_accounts" ADD CONSTRAINT "wallet_ledger_accounts_wallet_id_wallet_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallet_wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger_accounts" ADD CONSTRAINT "wallet_ledger_accounts_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger_postings" ADD CONSTRAINT "wallet_ledger_postings_transaction_id_wallet_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."wallet_ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger_postings" ADD CONSTRAINT "wallet_ledger_postings_account_id_wallet_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."wallet_ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger_transactions" ADD CONSTRAINT "wallet_ledger_transactions_idempotency_key_id_wallet_idempotency_keys_id_fk" FOREIGN KEY ("idempotency_key_id") REFERENCES "public"."wallet_idempotency_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger_transactions" ADD CONSTRAINT "wallet_ledger_transactions_correction_of_transaction_id_wallet_ledger_transactions_id_fk" FOREIGN KEY ("correction_of_transaction_id") REFERENCES "public"."wallet_ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger_transactions" ADD CONSTRAINT "wallet_ledger_transactions_created_by_user_id_auth_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_status_history" ADD CONSTRAINT "wallet_status_history_wallet_id_wallet_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallet_wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_status_history" ADD CONSTRAINT "wallet_status_history_actor_user_id_auth_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_status_history" ADD CONSTRAINT "wallet_status_history_actor_admin_id_auth_admin_id_fk" FOREIGN KEY ("actor_admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_wallets" ADD CONSTRAINT "wallet_wallets_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wallet_activities_user_time_idx" ON "wallet_activities" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "wallet_idempotency_keys_expiry_idx" ON "wallet_idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_ledger_accounts_wallet_type_uidx" ON "wallet_ledger_accounts" USING btree ("wallet_id","type") WHERE "wallet_ledger_accounts"."wallet_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "wallet_ledger_postings_transaction_idx" ON "wallet_ledger_postings" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "wallet_ledger_postings_account_idx" ON "wallet_ledger_postings" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "wallet_status_history_wallet_idx" ON "wallet_status_history" USING btree ("wallet_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_status_history_initial_uidx" ON "wallet_status_history" USING btree ("wallet_id") WHERE "wallet_status_history"."from_status" IS NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION wallet_reject_sealed_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.sealed_at IS NOT NULL THEN
    RAISE EXCEPTION 'sealed ledger transactions are immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION wallet_reject_sealed_posting_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  transaction_sealed timestamptz;
BEGIN
  SELECT sealed_at INTO transaction_sealed
  FROM wallet_ledger_transactions
  WHERE id = COALESCE(OLD.transaction_id, NEW.transaction_id);
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger postings may not be hard deleted';
  END IF;
  IF transaction_sealed IS NOT NULL THEN
    RAISE EXCEPTION 'sealed ledger postings are immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION wallet_validate_ledger_seal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  posting_count integer;
  posting_total bigint;
BEGIN
  IF NEW.sealed_at IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.sealed_at IS NULL) THEN
    SELECT count(*), COALESCE(sum(amount_satang), 0)
    INTO posting_count, posting_total
    FROM wallet_ledger_postings
    WHERE transaction_id = NEW.id;
    IF posting_count < 2 OR posting_total <> 0 THEN
      RAISE EXCEPTION 'ledger transaction must have at least two balanced postings';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER wallet_ledger_transactions_immutable
BEFORE UPDATE OR DELETE ON wallet_ledger_transactions
FOR EACH ROW EXECUTE FUNCTION wallet_reject_sealed_mutation();
--> statement-breakpoint
CREATE TRIGGER wallet_ledger_postings_immutable
BEFORE UPDATE OR DELETE ON wallet_ledger_postings
FOR EACH ROW EXECUTE FUNCTION wallet_reject_sealed_posting_mutation();
--> statement-breakpoint
CREATE TRIGGER wallet_ledger_transactions_validate_seal
BEFORE INSERT OR UPDATE ON wallet_ledger_transactions
FOR EACH ROW EXECUTE FUNCTION wallet_validate_ledger_seal();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION wallet_validate_account_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  wallet_user_id text;
BEGIN
  IF NEW.wallet_id IS NOT NULL THEN
    SELECT user_id INTO wallet_user_id FROM wallet_wallets WHERE id = NEW.wallet_id;
    IF wallet_user_id IS NULL OR wallet_user_id <> NEW.user_id THEN
      RAISE EXCEPTION 'ledger account owner must match Wallet owner';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER wallet_ledger_accounts_owner_validate
BEFORE INSERT OR UPDATE ON wallet_ledger_accounts
FOR EACH ROW EXECUTE FUNCTION wallet_validate_account_owner();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION wallet_reject_owner_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id <> OLD.user_id THEN
    RAISE EXCEPTION 'Wallet ownership is immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER wallet_wallets_owner_immutable
BEFORE UPDATE OF user_id ON wallet_wallets
FOR EACH ROW EXECUTE FUNCTION wallet_reject_owner_change();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION wallet_reject_financial_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'financial records may not be hard deleted';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER wallet_wallets_no_hard_delete
BEFORE DELETE ON wallet_wallets
FOR EACH ROW EXECUTE FUNCTION wallet_reject_financial_delete();
--> statement-breakpoint
CREATE TRIGGER wallet_status_history_no_hard_delete
BEFORE DELETE ON wallet_status_history
FOR EACH ROW EXECUTE FUNCTION wallet_reject_financial_delete();
--> statement-breakpoint
CREATE TRIGGER wallet_ledger_accounts_no_hard_delete
BEFORE DELETE ON wallet_ledger_accounts
FOR EACH ROW EXECUTE FUNCTION wallet_reject_financial_delete();
--> statement-breakpoint
CREATE TRIGGER wallet_activities_no_hard_delete
BEFORE DELETE ON wallet_activities
FOR EACH ROW EXECUTE FUNCTION wallet_reject_financial_delete();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION wallet_reject_overlapping_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM payment_money_policy_revisions AS other
    WHERE other.id <> NEW.id
      AND NEW.effective_from < COALESCE(other.effective_until, 'infinity'::timestamptz)
      AND other.effective_from < COALESCE(NEW.effective_until, 'infinity'::timestamptz)
  ) THEN
    RAISE EXCEPTION 'Money Policy effective windows may not overlap';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_money_policy_no_overlap
BEFORE INSERT OR UPDATE ON payment_money_policy_revisions
FOR EACH ROW EXECUTE FUNCTION wallet_reject_overlapping_policy();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION wallet_reject_policy_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Money Policy revisions are immutable';
  END IF;
  IF OLD.effective_until IS NULL
    AND NEW.effective_until IS NOT NULL
    AND (to_jsonb(NEW) - 'effective_until') = (to_jsonb(OLD) - 'effective_until') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Money Policy revision values are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_money_policy_immutable
BEFORE UPDATE OR DELETE ON payment_money_policy_revisions
FOR EACH ROW EXECUTE FUNCTION wallet_reject_policy_mutation();
--> statement-breakpoint
INSERT INTO payment_money_policy_revisions (
  revision,
  minimum_top_up_satang,
  maximum_top_up_satang,
  minimum_funding_reservation_satang,
  maximum_funding_reservation_satang,
  minimum_earnings_conversion_satang,
  maximum_earnings_conversion_satang,
  minimum_payout_satang,
  maximum_payout_satang,
  platform_fee_bps,
  fee_rounding_mode,
  quote_lifetime_seconds,
  reason,
  effective_from
) VALUES (
  1,
  100,
  70000000,
  100,
  70000000,
  100,
  70000000,
  100,
  70000000,
  200,
  'UP',
  300,
  'Initial Wallet & Payments policy',
  '2026-01-01T00:00:00.000Z'
);
