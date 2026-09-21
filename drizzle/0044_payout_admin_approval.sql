ALTER TABLE "payment_payout_status_history" DROP CONSTRAINT "payment_payout_status_history_from_status_check";--> statement-breakpoint
ALTER TABLE "payment_payout_status_history" DROP CONSTRAINT "payment_payout_status_history_to_status_check";--> statement-breakpoint
ALTER TABLE "payment_payouts" DROP CONSTRAINT "payment_payouts_status_check";--> statement-breakpoint
DROP INDEX "payment_payouts_active_user_uidx";--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD COLUMN "destination_masked_last_four" text DEFAULT '****' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD COLUMN "destination_masked_routing_value" text DEFAULT '****' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD COLUMN "provider_submission_claimed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_payouts_active_user_uidx" ON "payment_payouts" USING btree ("user_id") WHERE "payment_payouts"."payout_status" IN ('PENDING_ADMIN_APPROVAL', 'CREATING', 'PENDING', 'AWAITING_RECONCILIATION');--> statement-breakpoint
ALTER TABLE "payment_payout_status_history" ADD CONSTRAINT "payment_payout_status_history_from_status_check" CHECK ("payment_payout_status_history"."from_status" IS NULL OR "payment_payout_status_history"."from_status" IN ('PENDING_ADMIN_APPROVAL', 'CREATING', 'PENDING', 'AWAITING_RECONCILIATION', 'COMPLETED', 'FAILED', 'CANCELLED'));--> statement-breakpoint
ALTER TABLE "payment_payout_status_history" ADD CONSTRAINT "payment_payout_status_history_to_status_check" CHECK ("payment_payout_status_history"."to_status" IN ('PENDING_ADMIN_APPROVAL', 'CREATING', 'PENDING', 'AWAITING_RECONCILIATION', 'COMPLETED', 'FAILED', 'CANCELLED'));--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD CONSTRAINT "payment_payouts_status_check" CHECK ("payment_payouts"."payout_status" IN ('PENDING_ADMIN_APPROVAL', 'CREATING', 'PENDING', 'AWAITING_RECONCILIATION', 'COMPLETED', 'FAILED', 'CANCELLED'));