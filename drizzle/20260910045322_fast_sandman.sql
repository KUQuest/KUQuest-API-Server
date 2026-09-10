CREATE TABLE "quest_command" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quest_id" uuid,
	"principal_user_id" uuid NOT NULL,
	"operation_scope" varchar(64) NOT NULL,
	"key" varchar(200) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"resource_type" varchar(64),
	"resource_id" uuid,
	"result_data" jsonb,
	"processing_status" varchar(32) DEFAULT 'PROCESSING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "quest_command_principal_user_id_operation_scope_key_key" UNIQUE("principal_user_id","operation_scope","key"),
	CONSTRAINT "quest_command_key_check" CHECK (btrim("quest_command"."key") <> ''),
	CONSTRAINT "quest_command_operation_scope_check" CHECK (btrim("quest_command"."operation_scope") <> ''),
	CONSTRAINT "quest_command_hash_check" CHECK ("quest_command"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "quest_command_status_check" CHECK ("quest_command"."processing_status" IN ('PROCESSING', 'COMPLETED')),
	CONSTRAINT "quest_command_completion_check" CHECK (("quest_command"."processing_status" = 'COMPLETED') = ("quest_command"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "quest_command" ADD CONSTRAINT "quest_command_quest_id_quest_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quest"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_command" ADD CONSTRAINT "quest_command_principal_user_id_auth_user_id_fk" FOREIGN KEY ("principal_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quest_command_quest_idx" ON "quest_command" USING btree ("quest_id");--> statement-breakpoint
CREATE INDEX "quest_command_principal_idx" ON "quest_command" USING btree ("principal_user_id");--> statement-breakpoint
CREATE INDEX "quest_command_expiry_idx" ON "quest_command" USING btree ("expires_at");