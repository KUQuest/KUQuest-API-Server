CREATE TABLE "quest_candidate_selection_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"command_id" varchar(200) NOT NULL,
	"hirer_id" uuid NOT NULL,
	"quest_id" uuid NOT NULL,
	"target_type" varchar(32) NOT NULL,
	"target_id" uuid NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"result_assignment_ids" jsonb,
	"result_quest_status" "quest_status",
	"processing_status" varchar(32) DEFAULT 'PROCESSING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "quest_candidate_selection_commands_command_id_key" UNIQUE("command_id"),
	CONSTRAINT "quest_candidate_selection_commands_target_type_check" CHECK ("quest_candidate_selection_commands"."target_type" IN ('APPLICATION', 'TEAM')),
	CONSTRAINT "quest_candidate_selection_commands_status_check" CHECK ("quest_candidate_selection_commands"."processing_status" IN ('PROCESSING', 'COMPLETED')),
	CONSTRAINT "quest_candidate_selection_commands_completion_check" CHECK (("quest_candidate_selection_commands"."processing_status" = 'COMPLETED') = ("quest_candidate_selection_commands"."completed_at" IS NOT NULL)),
	CONSTRAINT "quest_candidate_selection_commands_result_check" CHECK ("quest_candidate_selection_commands"."processing_status" = 'PROCESSING' OR ("quest_candidate_selection_commands"."result_assignment_ids" IS NOT NULL AND "quest_candidate_selection_commands"."result_quest_status" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "quest_candidate_selection_commands" ADD CONSTRAINT "quest_candidate_selection_commands_hirer_id_auth_user_id_fk" FOREIGN KEY ("hirer_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_candidate_selection_commands" ADD CONSTRAINT "quest_candidate_selection_commands_quest_id_quest_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quest"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quest_candidate_selection_commands_quest_id_idx" ON "quest_candidate_selection_commands" USING btree ("quest_id");--> statement-breakpoint
CREATE INDEX "quest_candidate_selection_commands_hirer_id_idx" ON "quest_candidate_selection_commands" USING btree ("hirer_id");