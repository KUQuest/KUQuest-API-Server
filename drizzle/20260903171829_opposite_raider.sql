CREATE TABLE "admin_review_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quest_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"proof_submission_id" uuid NOT NULL,
	"hirer_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"team_id" uuid,
	"reason" varchar(1000) NOT NULL,
	"evidence_references" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_review_item_proof_submission_key" UNIQUE("proof_submission_id"),
	CONSTRAINT "admin_review_item_reason_check" CHECK (btrim("admin_review_item"."reason") <> ''),
	CONSTRAINT "admin_review_item_evidence_check" CHECK (jsonb_typeof("admin_review_item"."evidence_references") = 'array' AND jsonb_array_length("admin_review_item"."evidence_references") > 0)
);
--> statement-breakpoint
CREATE TABLE "audit_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" varchar(16) NOT NULL,
	"actor_user_id" uuid,
	"actor_admin_id" uuid,
	"action" varchar(64) NOT NULL,
	"resource_type" varchar(64) NOT NULL,
	"resource_id" varchar(200) NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb,
	"reason" varchar(1000),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_record_actor_check" CHECK (("audit_record"."actor_type" = 'SYSTEM' AND num_nonnulls("audit_record"."actor_user_id", "audit_record"."actor_admin_id") = 0) OR ("audit_record"."actor_type" = 'MEMBER' AND "audit_record"."actor_user_id" IS NOT NULL AND "audit_record"."actor_admin_id" IS NULL) OR ("audit_record"."actor_type" = 'ADMIN' AND "audit_record"."actor_user_id" IS NULL AND "audit_record"."actor_admin_id" IS NOT NULL)),
	CONSTRAINT "audit_record_action_check" CHECK (btrim("audit_record"."action") <> ''),
	CONSTRAINT "audit_record_resource_type_check" CHECK (btrim("audit_record"."resource_type") <> ''),
	CONSTRAINT "audit_record_resource_id_check" CHECK (btrim("audit_record"."resource_id") <> ''),
	CONSTRAINT "audit_record_reason_check" CHECK ("audit_record"."reason" IS NULL OR btrim("audit_record"."reason") <> ''),
	CONSTRAINT "audit_record_old_value_check" CHECK ("audit_record"."old_value" IS NULL OR jsonb_typeof("audit_record"."old_value") = 'object'),
	CONSTRAINT "audit_record_new_value_check" CHECK ("audit_record"."new_value" IS NULL OR jsonb_typeof("audit_record"."new_value") = 'object')
);
--> statement-breakpoint
ALTER TABLE "admin_review_item" ADD CONSTRAINT "admin_review_item_quest_id_quest_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quest"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_review_item" ADD CONSTRAINT "admin_review_item_assignment_id_quest_assignment_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."quest_assignment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_review_item" ADD CONSTRAINT "admin_review_item_proof_submission_id_quest_v2_proof_submission_id_fk" FOREIGN KEY ("proof_submission_id") REFERENCES "public"."quest_v2_proof_submission"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_review_item" ADD CONSTRAINT "admin_review_item_hirer_id_auth_user_id_fk" FOREIGN KEY ("hirer_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_review_item" ADD CONSTRAINT "admin_review_item_worker_id_auth_user_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_review_item" ADD CONSTRAINT "admin_review_item_team_id_quest_candidate_team_v2_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."quest_candidate_team_v2"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_record" ADD CONSTRAINT "audit_record_actor_user_id_auth_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_record" ADD CONSTRAINT "audit_record_actor_admin_id_auth_admin_id_fk" FOREIGN KEY ("actor_admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_review_item_quest_idx" ON "admin_review_item" USING btree ("quest_id","created_at");--> statement-breakpoint
CREATE INDEX "admin_review_item_assignment_idx" ON "admin_review_item" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX "admin_review_item_worker_idx" ON "admin_review_item" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "audit_record_resource_idx" ON "audit_record" USING btree ("resource_type","resource_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_record_created_idx" ON "audit_record" USING btree ("created_at");