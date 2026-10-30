ALTER TABLE "quest" ADD COLUMN "dispute_window_closed_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quest_v2_proof_submission" ADD COLUMN "review_reason" varchar(1000);--> statement-breakpoint
ALTER TABLE "quest_v2_proof_submission" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quest_v2_proof_submission" ADD COLUMN "reviewed_by" varchar(16);