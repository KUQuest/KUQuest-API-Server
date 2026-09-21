ALTER TABLE "quest" ADD COLUMN "funding_reservation_id" uuid;--> statement-breakpoint
ALTER TABLE "quest" ADD COLUMN "policy_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "quest" ADD COLUMN "platform_fee_bps" smallint;--> statement-breakpoint
ALTER TABLE "quest" ADD COLUMN "platform_fee_per_worker_satang" integer;--> statement-breakpoint
ALTER TABLE "quest" ADD COLUMN "quest_escrow_satang" integer;--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_funding_reservation_id_wallet_funding_reservations_id_fk" FOREIGN KEY ("funding_reservation_id") REFERENCES "public"."wallet_funding_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_policy_revision_id_payment_money_policy_revisions_id_fk" FOREIGN KEY ("policy_revision_id") REFERENCES "public"."payment_money_policy_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_funding_reservation_id_unique" UNIQUE("funding_reservation_id");--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_finance_snapshot_bps_check" CHECK ("quest"."platform_fee_bps" IS NULL OR "quest"."platform_fee_bps" BETWEEN 0 AND 10000);--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_finance_snapshot_amounts_check" CHECK ("quest"."platform_fee_per_worker_satang" IS NULL OR "quest"."platform_fee_per_worker_satang" >= 0);--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_finance_snapshot_escrow_check" CHECK ("quest"."quest_escrow_satang" IS NULL OR "quest"."quest_escrow_satang" > 0);