ALTER TABLE "profile_certificate" ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "profile_portfolio_item" ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "profile_work_experience" ADD COLUMN "deleted_at" timestamp with time zone;
