CREATE TABLE "quest_direct_join_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"command_id" varchar(200) NOT NULL,
	"worker_id" uuid NOT NULL,
	"quest_id" uuid NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"assignment_id" uuid,
	"result_quest_status" "quest_status",
	"processing_status" varchar(32) DEFAULT 'PROCESSING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "quest_direct_join_commands_command_id_key" UNIQUE("command_id"),
	CONSTRAINT "quest_direct_join_commands_assignment_id_key" UNIQUE("assignment_id"),
	CONSTRAINT "quest_direct_join_commands_status_check" CHECK ("quest_direct_join_commands"."processing_status" IN ('PROCESSING', 'COMPLETED')),
	CONSTRAINT "quest_direct_join_commands_completion_check" CHECK (("quest_direct_join_commands"."processing_status" = 'COMPLETED') = ("quest_direct_join_commands"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "quest_direct_join_commands" ADD CONSTRAINT "quest_direct_join_commands_worker_id_auth_user_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_direct_join_commands" ADD CONSTRAINT "quest_direct_join_commands_quest_id_quest_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quest"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_direct_join_commands" ADD CONSTRAINT "quest_direct_join_commands_assignment_id_quest_assignment_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."quest_assignment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quest_direct_join_commands_quest_id_idx" ON "quest_direct_join_commands" USING btree ("quest_id");--> statement-breakpoint
CREATE INDEX "quest_direct_join_commands_worker_id_idx" ON "quest_direct_join_commands" USING btree ("worker_id");