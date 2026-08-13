ALTER TABLE "auth_user" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "profile_certificate" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "profile_portfolio_item" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "profile_work_experience" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;