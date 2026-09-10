ALTER TABLE "payment_payout_status_history" DROP CONSTRAINT "payment_payout_status_history_from_status_check";--> statement-breakpoint
ALTER TABLE "payment_payout_status_history" DROP CONSTRAINT "payment_payout_status_history_to_status_check";--> statement-breakpoint
ALTER TABLE "payment_payouts" DROP CONSTRAINT "payment_payouts_status_check";--> statement-breakpoint
ALTER TABLE "payment_provider_event_inbox" DROP CONSTRAINT "payment_provider_event_inbox_normalized_status_check";--> statement-breakpoint
DROP INDEX "payment_payouts_active_user_uidx";--> statement-breakpoint
UPDATE "payment_payouts"
SET "payout_status" = CASE "payout_status"
  WHEN 'CREATING' THEN 'SUBMITTED_TO_PROVIDER'
  WHEN 'PENDING' THEN 'PROVIDER_PENDING'
  WHEN 'AWAITING_RECONCILIATION' THEN 'PROVIDER_PENDING'
  WHEN 'COMPLETED' THEN 'SUCCEEDED'
  ELSE "payout_status"
END;--> statement-breakpoint
ALTER TABLE "payment_payout_status_history" DISABLE TRIGGER "payment_payout_status_history_immutable";--> statement-breakpoint
UPDATE "payment_payout_status_history"
SET
  "from_status" = CASE "from_status"
    WHEN 'CREATING' THEN 'SUBMITTED_TO_PROVIDER'
    WHEN 'PENDING' THEN 'PROVIDER_PENDING'
    WHEN 'AWAITING_RECONCILIATION' THEN 'PROVIDER_PENDING'
    WHEN 'COMPLETED' THEN 'SUCCEEDED'
    ELSE "from_status"
  END,
  "to_status" = CASE "to_status"
    WHEN 'CREATING' THEN 'SUBMITTED_TO_PROVIDER'
    WHEN 'PENDING' THEN 'PROVIDER_PENDING'
    WHEN 'AWAITING_RECONCILIATION' THEN 'PROVIDER_PENDING'
    WHEN 'COMPLETED' THEN 'SUCCEEDED'
    ELSE "to_status"
  END,
  "source" = CASE "source" WHEN 'ADMIN_REJECTION' THEN 'ADMIN_CANCELLATION' ELSE "source" END;--> statement-breakpoint
ALTER TABLE "payment_payout_status_history" ENABLE TRIGGER "payment_payout_status_history_immutable";--> statement-breakpoint
UPDATE "payment_provider_event_inbox"
SET "normalized_status" = CASE "normalized_status"
  WHEN 'PENDING' THEN 'PROVIDER_PENDING'
  WHEN 'COMPLETED' THEN 'SUCCEEDED'
  ELSE "normalized_status"
END
WHERE "resource_type" = 'PAYOUT';--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_payouts_active_user_uidx" ON "payment_payouts" USING btree ("user_id") WHERE "payment_payouts"."payout_status" IN ('PENDING_ADMIN_APPROVAL', 'SUBMITTED_TO_PROVIDER', 'PROVIDER_PENDING');--> statement-breakpoint
ALTER TABLE "payment_payout_status_history" ADD CONSTRAINT "payment_payout_status_history_from_status_check" CHECK ("payment_payout_status_history"."from_status" IS NULL OR "payment_payout_status_history"."from_status" IN ('PENDING_ADMIN_APPROVAL', 'SUBMITTED_TO_PROVIDER', 'PROVIDER_PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED'));--> statement-breakpoint
ALTER TABLE "payment_payout_status_history" ADD CONSTRAINT "payment_payout_status_history_to_status_check" CHECK ("payment_payout_status_history"."to_status" IN ('PENDING_ADMIN_APPROVAL', 'SUBMITTED_TO_PROVIDER', 'PROVIDER_PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED'));--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD CONSTRAINT "payment_payouts_version_check" CHECK ("payment_payouts"."version" >= 1);--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD CONSTRAINT "payment_payouts_status_check" CHECK ("payment_payouts"."payout_status" IN ('PENDING_ADMIN_APPROVAL', 'SUBMITTED_TO_PROVIDER', 'PROVIDER_PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED'));--> statement-breakpoint
ALTER TABLE "payment_provider_event_inbox" ADD CONSTRAINT "payment_provider_event_inbox_normalized_status_check" CHECK ("payment_provider_event_inbox"."normalized_status" IN ('PENDING', 'PAID', 'EXPIRED', 'FAILED', 'PROVIDER_PENDING', 'SUCCEEDED', 'CANCELLED'));
