ALTER TABLE "quest" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_version_check" CHECK ("quest"."version" >= 1);