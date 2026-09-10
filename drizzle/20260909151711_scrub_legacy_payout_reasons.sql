ALTER TABLE "payment_payout_status_history" DISABLE TRIGGER "payment_payout_status_history_immutable";--> statement-breakpoint
UPDATE "payment_payout_status_history"
SET "reason" = CASE
  WHEN "source" = 'ADMIN_APPROVAL'
    AND "to_status" = 'SUBMITTED_TO_PROVIDER'
    AND "reason" IN ('PAYOUT_POLICY_REVIEW', 'PAYOUT_RISK_REVIEW')
    THEN "reason"
  WHEN "source" = 'ADMIN_CANCELLATION'
    AND "to_status" = 'CANCELLED'
    AND "reason" IN ('PAYOUT_POLICY_REVIEW', 'PAYOUT_RISK_REVIEW', 'PAYOUT_INVALID_DESTINATION')
    THEN "reason"
  ELSE NULL
END
WHERE ("source" = 'ADMIN_APPROVAL' AND "to_status" = 'SUBMITTED_TO_PROVIDER')
   OR ("source" = 'ADMIN_CANCELLATION' AND "to_status" = 'CANCELLED');--> statement-breakpoint
ALTER TABLE "payment_payout_status_history" ENABLE TRIGGER "payment_payout_status_history_immutable";
