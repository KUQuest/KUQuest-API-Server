CREATE TABLE "admin_action" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_id" uuid NOT NULL,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"request_key" text NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"reason_catalog_version" integer NOT NULL,
	"reason_code" text,
	"expected_version" integer,
	"expected_timestamp" timestamp with time zone,
	"result_version" integer,
	"result_timestamp" timestamp with time zone,
	"metadata" jsonb NOT NULL,
	"result_data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_action_admin_action_request_key" UNIQUE("admin_id","action","request_key"),
	CONSTRAINT "admin_action_action_check" CHECK (btrim("admin_action"."action") <> ''),
	CONSTRAINT "admin_action_resource_type_check" CHECK (btrim("admin_action"."resource_type") <> ''),
	CONSTRAINT "admin_action_resource_id_check" CHECK (btrim("admin_action"."resource_id") <> ''),
	CONSTRAINT "admin_action_request_key_check" CHECK (btrim("admin_action"."request_key") <> ''),
	CONSTRAINT "admin_action_request_hash_check" CHECK ("admin_action"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "admin_action_reason_catalog_version_check" CHECK ("admin_action"."reason_catalog_version" >= 1),
	CONSTRAINT "admin_action_reason_code_check" CHECK ("admin_action"."reason_code" IS NULL OR "admin_action"."reason_code" ~ '^[A-Z][A-Z0-9_.-]{0,99}$'),
	CONSTRAINT "admin_action_resource_version_check" CHECK (("admin_action"."expected_version" IS NULL OR "admin_action"."expected_version" >= 1) AND ("admin_action"."result_version" IS NULL OR "admin_action"."result_version" >= 1)),
	CONSTRAINT "admin_action_resource_revision_check" CHECK (num_nonnulls("admin_action"."expected_version", "admin_action"."expected_timestamp") <= 1 AND num_nonnulls("admin_action"."result_version", "admin_action"."result_timestamp") <= 1),
	CONSTRAINT "admin_action_metadata_object_check" CHECK (jsonb_typeof("admin_action"."metadata") = 'object'),
	CONSTRAINT "admin_action_result_data_object_check" CHECK (jsonb_typeof("admin_action"."result_data") = 'object')
);
--> statement-breakpoint
ALTER TABLE "quest" DROP CONSTRAINT "quest_hidden_at_check";--> statement-breakpoint
ALTER TABLE "quest" DROP CONSTRAINT "quest_tag_check";--> statement-breakpoint
ALTER TABLE "quest" DROP CONSTRAINT "quest_v2_draft_reward_check";--> statement-breakpoint
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
ALTER TABLE "quest" ADD CONSTRAINT "quest_cancelled_at_check" CHECK (("quest"."cancelled_at" IS NULL) = ("quest"."quest_status" <> 'QUEST_CANCELLED'));--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_reward_required_check" CHECK (("quest"."api_version" = 'v2' AND "quest"."quest_status" = 'QUEST_DRAFT') OR "quest"."reward_satang" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "admin_action" ADD CONSTRAINT "admin_action_admin_id_auth_admin_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_action_resource_idx" ON "admin_action" USING btree ("resource_type","resource_id","created_at");--> statement-breakpoint
CREATE INDEX "admin_action_admin_created_idx" ON "admin_action" USING btree ("admin_id","created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION admin_action_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Admin Action is immutable';
END;
$$;--> statement-breakpoint
CREATE TRIGGER admin_action_immutable
BEFORE UPDATE OR DELETE ON admin_action
FOR EACH ROW EXECUTE FUNCTION admin_action_reject_mutation();