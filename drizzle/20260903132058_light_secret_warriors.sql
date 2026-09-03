CREATE TABLE "quest_v2_completion_confirmation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quest_id" uuid NOT NULL,
	"worker_id" uuid,
	"team_id" uuid,
	"confirmed_by_user_id" uuid NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quest_v2_completion_confirmation_worker_key" UNIQUE("quest_id","worker_id"),
	CONSTRAINT "quest_v2_completion_confirmation_team_key" UNIQUE("quest_id","team_id"),
	CONSTRAINT "quest_v2_completion_confirmation_owner_check" CHECK (num_nonnulls("quest_v2_completion_confirmation"."worker_id", "quest_v2_completion_confirmation"."team_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "quest_v2_proof_submission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quest_id" uuid NOT NULL,
	"worker_id" uuid,
	"team_id" uuid,
	"submitted_by_user_id" uuid NOT NULL,
	"description" varchar(1000),
	"submission_status" varchar(32),
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quest_v2_proof_submission_owner_check" CHECK (num_nonnulls("quest_v2_proof_submission"."worker_id", "quest_v2_proof_submission"."team_id") = 1),
	CONSTRAINT "quest_v2_proof_submission_status_check" CHECK ("quest_v2_proof_submission"."submission_status" IS NULL OR "quest_v2_proof_submission"."submission_status" IN ('PROOF_PENDING', 'PROOF_APPROVED', 'PROOF_NOT_APPROVED')),
	CONSTRAINT "quest_v2_proof_submission_draft_check" CHECK (("quest_v2_proof_submission"."submission_status" IS NULL) = ("quest_v2_proof_submission"."sent_at" IS NULL)),
	CONSTRAINT "quest_v2_proof_submission_description_check" CHECK ("quest_v2_proof_submission"."description" IS NULL OR btrim("quest_v2_proof_submission"."description") <> '')
);
--> statement-breakpoint
CREATE TABLE "quest_v2_proof_submission_file" (
	"proof_submission_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"attached_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quest_v2_proof_submission_file_proof_submission_id_file_id_pk" PRIMARY KEY("proof_submission_id","file_id"),
	CONSTRAINT "quest_v2_proof_submission_file_position_key" UNIQUE("proof_submission_id","position"),
	CONSTRAINT "quest_v2_proof_submission_file_position_check" CHECK ("quest_v2_proof_submission_file"."position" >= 0 AND "quest_v2_proof_submission_file"."position" < 5)
);
--> statement-breakpoint
ALTER TABLE "quest_v2_completion_confirmation" ADD CONSTRAINT "quest_v2_completion_confirmation_quest_id_quest_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quest"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_v2_completion_confirmation" ADD CONSTRAINT "quest_v2_completion_confirmation_worker_id_auth_user_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_v2_completion_confirmation" ADD CONSTRAINT "quest_v2_completion_confirmation_team_id_quest_candidate_team_v2_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."quest_candidate_team_v2"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_v2_completion_confirmation" ADD CONSTRAINT "quest_v2_completion_confirmation_confirmed_by_user_id_auth_user_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_v2_proof_submission" ADD CONSTRAINT "quest_v2_proof_submission_quest_id_quest_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quest"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_v2_proof_submission" ADD CONSTRAINT "quest_v2_proof_submission_worker_id_auth_user_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_v2_proof_submission" ADD CONSTRAINT "quest_v2_proof_submission_team_id_quest_candidate_team_v2_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."quest_candidate_team_v2"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_v2_proof_submission" ADD CONSTRAINT "quest_v2_proof_submission_submitted_by_user_id_auth_user_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_v2_proof_submission_file" ADD CONSTRAINT "quest_v2_proof_submission_file_proof_submission_id_quest_v2_proof_submission_id_fk" FOREIGN KEY ("proof_submission_id") REFERENCES "public"."quest_v2_proof_submission"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_v2_proof_submission_file" ADD CONSTRAINT "quest_v2_proof_submission_file_file_id_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quest_v2_completion_confirmation_quest_idx" ON "quest_v2_completion_confirmation" USING btree ("quest_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quest_v2_proof_submission_one_worker_uidx" ON "quest_v2_proof_submission" USING btree ("quest_id","worker_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quest_v2_proof_submission_one_team_uidx" ON "quest_v2_proof_submission" USING btree ("quest_id","team_id");--> statement-breakpoint
CREATE INDEX "quest_v2_proof_submission_quest_idx" ON "quest_v2_proof_submission" USING btree ("quest_id");--> statement-breakpoint
CREATE INDEX "quest_v2_proof_submission_worker_idx" ON "quest_v2_proof_submission" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "quest_v2_proof_submission_team_idx" ON "quest_v2_proof_submission" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "quest_v2_proof_submission_status_idx" ON "quest_v2_proof_submission" USING btree ("submission_status");--> statement-breakpoint
CREATE INDEX "quest_v2_proof_submission_file_submission_idx" ON "quest_v2_proof_submission_file" USING btree ("proof_submission_id");