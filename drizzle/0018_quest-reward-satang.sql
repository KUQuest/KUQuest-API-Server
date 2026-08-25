ALTER TABLE "quest" DROP CONSTRAINT "quest_reward_check";--> statement-breakpoint
ALTER TABLE "quest" RENAME COLUMN "reward_baht" TO "reward_satang";--> statement-breakpoint
ALTER TABLE "quest" ALTER COLUMN "reward_satang" SET DATA TYPE integer USING ("reward_satang" * 100);--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_reward_check" CHECK ("quest"."reward_satang" > 0);
