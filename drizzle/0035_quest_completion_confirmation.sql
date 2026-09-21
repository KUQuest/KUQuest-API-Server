CREATE TABLE "quest_completion_confirmation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quest_id" uuid NOT NULL,
	"worker_id" uuid,
	"team_id" uuid,
	"confirmed_by_user_id" uuid NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quest_completion_confirmation_worker_key" UNIQUE("quest_id","worker_id"),
	CONSTRAINT "quest_completion_confirmation_team_key" UNIQUE("quest_id","team_id"),
	CONSTRAINT "quest_completion_confirmation_owner_check" CHECK (num_nonnulls("quest_completion_confirmation"."worker_id", "quest_completion_confirmation"."team_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "quest_completion_confirmation" ADD CONSTRAINT "quest_completion_confirmation_quest_id_quest_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quest"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_completion_confirmation" ADD CONSTRAINT "quest_completion_confirmation_worker_id_auth_user_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_completion_confirmation" ADD CONSTRAINT "quest_completion_confirmation_team_id_quest_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."quest_team"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_completion_confirmation" ADD CONSTRAINT "quest_completion_confirmation_confirmed_by_user_id_auth_user_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quest_completion_confirmation_quest_idx" ON "quest_completion_confirmation" USING btree ("quest_id");