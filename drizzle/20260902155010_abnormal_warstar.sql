CREATE TABLE "quest_candidate_application_v2" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quest_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"state" varchar(32) DEFAULT 'APPLICATION_APPLIED' NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quest_candidate_application_v2_quest_id_member_id_key" UNIQUE("quest_id","member_id"),
	CONSTRAINT "quest_candidate_application_v2_state_check" CHECK ("quest_candidate_application_v2"."state" IN ('APPLICATION_APPLIED', 'APPLICATION_SELECTED', 'APPLICATION_REJECTED', 'APPLICATION_WITHDRAWN'))
);
--> statement-breakpoint
CREATE TABLE "quest_candidate_team_v2" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quest_id" uuid NOT NULL,
	"leader_id" uuid NOT NULL,
	"headcount" integer NOT NULL,
	"state" varchar(32) DEFAULT 'TEAM_FORMING' NOT NULL,
	"join_code_hash" varchar(64),
	"join_code_expires_at" timestamp with time zone,
	"submission_text" varchar(1000),
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quest_candidate_team_v2_state_check" CHECK ("quest_candidate_team_v2"."state" IN ('TEAM_FORMING', 'TEAM_SUBMITTED', 'TEAM_SELECTED', 'TEAM_REJECTED', 'TEAM_DISBANDED')),
	CONSTRAINT "quest_candidate_team_v2_headcount_check" CHECK ("quest_candidate_team_v2"."headcount" BETWEEN 2 AND 20),
	CONSTRAINT "quest_candidate_team_v2_join_code_fields_check" CHECK (("quest_candidate_team_v2"."join_code_hash" IS NULL) = ("quest_candidate_team_v2"."join_code_expires_at" IS NULL)),
	CONSTRAINT "quest_candidate_team_v2_submission_fields_check" CHECK (("quest_candidate_team_v2"."submission_text" IS NULL) = ("quest_candidate_team_v2"."submitted_at" IS NULL)),
	CONSTRAINT "quest_candidate_team_v2_submission_text_check" CHECK ("quest_candidate_team_v2"."submission_text" IS NULL OR btrim("quest_candidate_team_v2"."submission_text") <> '')
);
--> statement-breakpoint
CREATE TABLE "quest_candidate_team_v2_member" (
	"team_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quest_candidate_team_v2_member_team_id_member_id_pk" PRIMARY KEY("team_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "quest_candidate_team_v2_submission_file" (
	"team_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"attached_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quest_candidate_team_v2_submission_file_team_id_file_id_pk" PRIMARY KEY("team_id","file_id"),
	CONSTRAINT "quest_candidate_team_v2_submission_file_team_position_key" UNIQUE("team_id","position"),
	CONSTRAINT "quest_candidate_team_v2_submission_file_position_check" CHECK ("quest_candidate_team_v2_submission_file"."position" >= 0)
);
--> statement-breakpoint
ALTER TABLE "quest_candidate_application_v2" ADD CONSTRAINT "quest_candidate_application_v2_quest_id_quest_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quest"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_candidate_application_v2" ADD CONSTRAINT "quest_candidate_application_v2_member_id_auth_user_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_candidate_team_v2" ADD CONSTRAINT "quest_candidate_team_v2_quest_id_quest_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quest"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_candidate_team_v2" ADD CONSTRAINT "quest_candidate_team_v2_leader_id_auth_user_id_fk" FOREIGN KEY ("leader_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_candidate_team_v2_member" ADD CONSTRAINT "quest_candidate_team_v2_member_team_id_quest_candidate_team_v2_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."quest_candidate_team_v2"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_candidate_team_v2_member" ADD CONSTRAINT "quest_candidate_team_v2_member_member_id_auth_user_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_candidate_team_v2_submission_file" ADD CONSTRAINT "quest_candidate_team_v2_submission_file_team_id_quest_candidate_team_v2_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."quest_candidate_team_v2"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_candidate_team_v2_submission_file" ADD CONSTRAINT "quest_candidate_team_v2_submission_file_file_id_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quest_candidate_application_v2_quest_id_idx" ON "quest_candidate_application_v2" USING btree ("quest_id");--> statement-breakpoint
CREATE INDEX "quest_candidate_application_v2_state_idx" ON "quest_candidate_application_v2" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "quest_candidate_application_v2_one_selected_uidx" ON "quest_candidate_application_v2" USING btree ("quest_id") WHERE "quest_candidate_application_v2"."state" = 'APPLICATION_SELECTED';--> statement-breakpoint
CREATE INDEX "quest_candidate_team_v2_quest_id_idx" ON "quest_candidate_team_v2" USING btree ("quest_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quest_candidate_team_v2_one_selected_uidx" ON "quest_candidate_team_v2" USING btree ("quest_id") WHERE "quest_candidate_team_v2"."state" = 'TEAM_SELECTED';--> statement-breakpoint
CREATE INDEX "quest_candidate_team_v2_member_member_id_idx" ON "quest_candidate_team_v2_member" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "quest_candidate_team_v2_submission_file_team_idx" ON "quest_candidate_team_v2_submission_file" USING btree ("team_id");