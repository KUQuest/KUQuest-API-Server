CREATE TABLE "quest_settlement_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"command_id" varchar(200) NOT NULL,
	"quest_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"actor_admin_id" uuid,
	"command_type" varchar(32) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"result_data" jsonb,
	"processing_status" varchar(32) DEFAULT 'PROCESSING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "quest_settlement_commands_command_id_key" UNIQUE("command_id"),
	CONSTRAINT "quest_settlement_commands_actor_check" CHECK (num_nonnulls("quest_settlement_commands"."actor_user_id", "quest_settlement_commands"."actor_admin_id") = 1),
	CONSTRAINT "quest_settlement_commands_type_check" CHECK ("quest_settlement_commands"."command_type" IN ('COMPLETE', 'CANCEL', 'DISPUTE_REFUND', 'DISPUTE_RELEASE')),
	CONSTRAINT "quest_settlement_commands_status_check" CHECK ("quest_settlement_commands"."processing_status" IN ('PROCESSING', 'COMPLETED')),
	CONSTRAINT "quest_settlement_commands_completion_check" CHECK (("quest_settlement_commands"."processing_status" = 'COMPLETED') = ("quest_settlement_commands"."completed_at" IS NOT NULL)),
	CONSTRAINT "quest_settlement_commands_result_check" CHECK ("quest_settlement_commands"."processing_status" = 'PROCESSING' OR "quest_settlement_commands"."result_data" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "quest_settlement_commands" ADD CONSTRAINT "quest_settlement_commands_quest_id_quest_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quest"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_settlement_commands" ADD CONSTRAINT "quest_settlement_commands_actor_user_id_auth_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_settlement_commands" ADD CONSTRAINT "quest_settlement_commands_actor_admin_id_auth_admin_id_fk" FOREIGN KEY ("actor_admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quest_settlement_commands_quest_id_idx" ON "quest_settlement_commands" USING btree ("quest_id");