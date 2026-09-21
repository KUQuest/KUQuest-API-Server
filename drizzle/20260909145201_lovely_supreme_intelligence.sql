CREATE TABLE "payment_payout_submission_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payout_id" uuid NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_payout_submission_jobs_payout_id_unique" UNIQUE("payout_id")
);
--> statement-breakpoint
ALTER TABLE "payment_payout_submission_jobs" ADD CONSTRAINT "payment_payout_submission_jobs_payout_id_payment_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payment_payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_payout_submission_jobs_pending_idx" ON "payment_payout_submission_jobs" USING btree ("processed_at","created_at");
--> statement-breakpoint
ALTER TABLE "payment_payout_status_history" DISABLE TRIGGER "payment_payout_status_history_immutable";
--> statement-breakpoint
UPDATE "payment_payout_status_history"
SET "reason" = CASE
  WHEN "reason" IN ('PAYOUT_POLICY_REVIEW', 'PAYOUT_RISK_REVIEW', 'PAYOUT_INVALID_DESTINATION') THEN "reason"
  ELSE NULL
END
WHERE "source" = 'ADMIN_CANCELLATION'
  AND "to_status" = 'CANCELLED';
--> statement-breakpoint
ALTER TABLE "payment_payout_status_history" ENABLE TRIGGER "payment_payout_status_history_immutable";
--> statement-breakpoint
INSERT INTO "payment_payout_submission_jobs" ("payout_id")
SELECT DISTINCT "history"."payout_id"
FROM "payment_payout_status_history" AS "history"
INNER JOIN "payment_payouts" AS "payout"
  ON "payout"."id" = "history"."payout_id"
WHERE "history"."source" = 'ADMIN_APPROVAL'
  AND "history"."to_status" = 'SUBMITTED_TO_PROVIDER'
  AND "payout"."payout_status" = 'SUBMITTED_TO_PROVIDER'
ON CONFLICT ("payout_id") DO NOTHING;
