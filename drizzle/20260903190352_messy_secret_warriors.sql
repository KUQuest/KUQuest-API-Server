ALTER TABLE "quest" DROP CONSTRAINT "quest_reward_required_check";--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_reward_required_check" CHECK ((
        ("quest"."api_version" = 'v2' AND "quest"."quest_status" IN ('QUEST_DRAFT', 'QUEST_CANCELLED') AND "quest"."funding_reservation_id" IS NULL)
        OR "quest"."reward_satang" IS NOT NULL
      ));