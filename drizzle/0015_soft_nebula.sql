ALTER TYPE "public"."quest_status" ADD VALUE 'AWAITING_CONSENT' BEFORE 'ASSIGNED';--> statement-breakpoint
ALTER TYPE "public"."quest_status" ADD VALUE 'UNFILLED';--> statement-breakpoint
ALTER TABLE "quest" ALTER COLUMN "mode" SET DATA TYPE text;--> statement-breakpoint
UPDATE "quest" SET "mode" = 'FIRST_COME_FIRST_SERVED' WHERE "mode" = 'NO_CANDIDATE';--> statement-breakpoint
DROP TYPE "public"."quest_mode";--> statement-breakpoint
CREATE TYPE "public"."quest_mode" AS ENUM('FIRST_COME_FIRST_SERVED', 'CANDIDATE');--> statement-breakpoint
ALTER TABLE "quest" ALTER COLUMN "mode" SET DATA TYPE "public"."quest_mode" USING "mode"::"public"."quest_mode";--> statement-breakpoint
ALTER TABLE "quest" ALTER COLUMN "participation" SET DATA TYPE text;--> statement-breakpoint
UPDATE "quest" SET "participation" = 'SINGLE' WHERE "participation" = 'SOLO';--> statement-breakpoint
ALTER TABLE "quest" ALTER COLUMN "participation" SET DEFAULT 'SINGLE'::text;--> statement-breakpoint
DROP TYPE "public"."quest_participation";--> statement-breakpoint
CREATE TYPE "public"."quest_participation" AS ENUM('SINGLE', 'GROUP');--> statement-breakpoint
ALTER TABLE "quest" ALTER COLUMN "participation" SET DEFAULT 'SINGLE'::"public"."quest_participation";--> statement-breakpoint
ALTER TABLE "quest" ALTER COLUMN "participation" SET DATA TYPE "public"."quest_participation" USING "participation"::"public"."quest_participation";