ALTER TABLE "quest" ADD COLUMN "money_hold_started_at" timestamp with time zone;--> statement-breakpoint
UPDATE "quest" SET "money_hold_started_at" = "failed_at" WHERE "quest_status" = 'QUEST_FAILED';--> statement-breakpoint
CREATE INDEX "quest_money_hold_started_at_idx" ON "quest" USING btree ("money_hold_started_at");--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_money_hold_started_at_check" CHECK (CASE "quest"."quest_status"
        WHEN 'QUEST_FAILED' THEN "quest"."money_hold_started_at" IS NOT DISTINCT FROM "quest"."failed_at"
        WHEN 'QUEST_COMPLETED' THEN true
        ELSE "quest"."money_hold_started_at" IS NULL
      END);
