CREATE TABLE "quest_v2_review_command" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(200) NOT NULL,
	"quest_id" uuid NOT NULL,
	"principal_user_id" uuid NOT NULL,
	"operation" varchar(64) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"resource_id" uuid,
	"result_data" jsonb,
	"processing_status" varchar(32) DEFAULT 'PROCESSING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "quest_v2_review_command_key_unique" UNIQUE("key"),
	CONSTRAINT "quest_v2_review_command_key_check" CHECK (btrim("quest_v2_review_command"."key") <> ''),
	CONSTRAINT "quest_v2_review_command_operation_check" CHECK (btrim("quest_v2_review_command"."operation") <> ''),
	CONSTRAINT "quest_v2_review_command_hash_check" CHECK ("quest_v2_review_command"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "quest_v2_review_command_status_check" CHECK ("quest_v2_review_command"."processing_status" IN ('PROCESSING', 'COMPLETED')),
	CONSTRAINT "quest_v2_review_command_completion_check" CHECK (("quest_v2_review_command"."processing_status" = 'COMPLETED') = ("quest_v2_review_command"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "quest_v2_review_command" ADD CONSTRAINT "quest_v2_review_command_quest_id_quest_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quest"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_v2_review_command" ADD CONSTRAINT "quest_v2_review_command_principal_user_id_auth_user_id_fk" FOREIGN KEY ("principal_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quest_v2_review_command_quest_idx" ON "quest_v2_review_command" USING btree ("quest_id");--> statement-breakpoint
CREATE INDEX "quest_v2_review_command_principal_idx" ON "quest_v2_review_command" USING btree ("principal_user_id");--> statement-breakpoint
CREATE INDEX "quest_v2_review_command_expiry_idx" ON "quest_v2_review_command" USING btree ("expires_at");