ALTER TABLE "quest" DROP CONSTRAINT "quest_hidden_at_check";--> statement-breakpoint
ALTER TABLE "quest" DROP CONSTRAINT "quest_tag_check";--> statement-breakpoint
ALTER TABLE "quest" DROP CONSTRAINT "quest_v2_draft_reward_check";--> statement-breakpoint
ALTER TABLE "quest" DROP CONSTRAINT "quest_participation_headcount_check";--> statement-breakpoint
ALTER TABLE "quest" DROP CONSTRAINT "quest_cancelled_at_check";--> statement-breakpoint
ALTER TABLE "quest" DROP CONSTRAINT "quest_reward_required_check";--> statement-breakpoint
UPDATE "quest" SET "quest_status" = 'QUEST_OPEN' WHERE "quest_status" = 'QUEST_HIDDEN';--> statement-breakpoint
UPDATE "quest_candidate_selection_commands" SET "result_quest_status" = 'QUEST_OPEN' WHERE "result_quest_status" = 'QUEST_HIDDEN';--> statement-breakpoint
UPDATE "quest_direct_join_commands" SET "result_quest_status" = 'QUEST_OPEN' WHERE "result_quest_status" = 'QUEST_HIDDEN';--> statement-breakpoint
UPDATE "quest_edit_request" SET "previous_quest_status" = 'QUEST_OPEN' WHERE "previous_quest_status" = 'QUEST_HIDDEN';--> statement-breakpoint
UPDATE "chat_conversation" SET "quest_status" = 'QUEST_OPEN' WHERE "quest_status" = 'QUEST_HIDDEN';--> statement-breakpoint
ALTER TABLE "quest" ALTER COLUMN "quest_status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "quest" ALTER COLUMN "quest_status" SET DEFAULT 'QUEST_DRAFT'::text;--> statement-breakpoint
ALTER TABLE "quest_candidate_selection_commands" ALTER COLUMN "result_quest_status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "quest_direct_join_commands" ALTER COLUMN "result_quest_status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "quest_edit_request" ALTER COLUMN "previous_quest_status" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."quest_status";--> statement-breakpoint
CREATE TYPE "public"."quest_status" AS ENUM('QUEST_DRAFT', 'QUEST_OPEN', 'QUEST_AWAITING_CONSENT', 'QUEST_ASSIGNED', 'QUEST_IN_PROGRESS', 'QUEST_SUBMITTED', 'QUEST_APPROVED', 'QUEST_REWORK', 'QUEST_COMPLETED', 'QUEST_CANCELLED', 'QUEST_DISPUTED', 'QUEST_FAILED');--> statement-breakpoint
ALTER TABLE "quest" ALTER COLUMN "quest_status" SET DEFAULT 'QUEST_DRAFT'::"public"."quest_status";--> statement-breakpoint
ALTER TABLE "quest" ALTER COLUMN "quest_status" SET DATA TYPE "public"."quest_status" USING "quest_status"::"public"."quest_status";--> statement-breakpoint
ALTER TABLE "quest_candidate_selection_commands" ALTER COLUMN "result_quest_status" SET DATA TYPE "public"."quest_status" USING "result_quest_status"::"public"."quest_status";--> statement-breakpoint
ALTER TABLE "quest_direct_join_commands" ALTER COLUMN "result_quest_status" SET DATA TYPE "public"."quest_status" USING "result_quest_status"::"public"."quest_status";--> statement-breakpoint
ALTER TABLE "quest_edit_request" ALTER COLUMN "previous_quest_status" SET DATA TYPE "public"."quest_status" USING "previous_quest_status"::"public"."quest_status";--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_tag_check" CHECK ("quest"."quest_status" IN ('QUEST_DRAFT', 'QUEST_CANCELLED') OR "quest"."tag_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_v2_draft_reward_check" CHECK ("quest"."api_version" <> 'v2' OR "quest"."quest_status" <> 'QUEST_DRAFT' OR "quest"."reward_satang" IS NULL);--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_participation_headcount_check" CHECK ((
  "quest"."api_version" <> 'v2' AND
  ("quest"."participation" = 'GROUP' OR "quest"."headcount" = 1)
) OR (
  "quest"."api_version" = 'v2' AND
  "quest"."v2_participation" IS NOT NULL AND
  (
    ("quest"."v2_participation" = 'SINGLE' AND "quest"."headcount" = 1) OR
    ("quest"."v2_participation" = 'GROUP' AND "quest"."headcount" BETWEEN 2 AND 20)
  )
));--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_cancelled_at_check" CHECK (("quest"."cancelled_at" IS NULL) = ("quest"."quest_status" <> 'QUEST_CANCELLED'));--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_reward_required_check" CHECK (("quest"."api_version" = 'v2' AND "quest"."quest_status" = 'QUEST_DRAFT') OR "quest"."reward_satang" IS NOT NULL);--> statement-breakpoint