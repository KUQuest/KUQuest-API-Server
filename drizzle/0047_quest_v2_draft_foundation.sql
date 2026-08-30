CREATE TABLE "quest_condition_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quest_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"text" varchar(255) NOT NULL,
	CONSTRAINT "quest_condition_item_quest_id_position_key" UNIQUE("quest_id","position"),
	CONSTRAINT "quest_condition_item_position_check" CHECK ("quest_condition_item"."position" >= 0),
	CONSTRAINT "quest_condition_item_text_check" CHECK (btrim("quest_condition_item"."text") <> '')
);
--> statement-breakpoint
ALTER TABLE "quest" ADD COLUMN "api_version" varchar(2) DEFAULT 'v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "quest" ADD COLUMN "v2_mode" varchar(32);--> statement-breakpoint
ALTER TABLE "quest" ADD COLUMN "v2_participation" varchar(16);--> statement-breakpoint
ALTER TABLE "quest" ADD COLUMN "quest_funding_total_satang" integer;--> statement-breakpoint
ALTER TABLE "quest_condition_item" ADD CONSTRAINT "quest_condition_item_quest_id_quest_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quest"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quest_condition_item_quest_id_idx" ON "quest_condition_item" USING btree ("quest_id");--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_api_version_check" CHECK ("quest"."api_version" IN ('v1', 'v2'));--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_v2_mode_check" CHECK ("quest"."v2_mode" IS NULL OR "quest"."v2_mode" IN ('FIRST_COME_FIRST_SERVED', 'CANDIDATE'));--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_v2_participation_check" CHECK ("quest"."v2_participation" IS NULL OR "quest"."v2_participation" IN ('SINGLE', 'GROUP'));--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_funding_total_check" CHECK ("quest"."quest_funding_total_satang" IS NULL OR "quest"."quest_funding_total_satang" BETWEEN 100 AND 70000000);