CREATE TABLE "admin_dispute_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quest_id" uuid NOT NULL,
	"filer_user_id" uuid NOT NULL,
	"opened_by_admin_id" uuid,
	"status" text DEFAULT 'DISPUTE_CASE_PENDING' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"resolved_worker_id" uuid,
	"resolved_amount_satang" integer,
	"resolved_by_admin_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_dispute_cases_quest_filer_key" UNIQUE("quest_id","filer_user_id"),
	CONSTRAINT "admin_dispute_cases_status_check" CHECK ("admin_dispute_cases"."status" IN ('DISPUTE_CASE_PENDING', 'DISPUTE_CASE_DISMISSED', 'DISPUTE_CASE_RESOLVED')),
	CONSTRAINT "admin_dispute_cases_version_check" CHECK ("admin_dispute_cases"."version" >= 1),
	CONSTRAINT "admin_dispute_cases_amount_check" CHECK ("admin_dispute_cases"."resolved_amount_satang" IS NULL OR "admin_dispute_cases"."resolved_amount_satang" BETWEEN 1 AND 2000000000),
	CONSTRAINT "admin_dispute_cases_terminal_fields_check" CHECK ((
        ("admin_dispute_cases"."status" = 'DISPUTE_CASE_PENDING' AND num_nonnulls("admin_dispute_cases"."resolved_worker_id", "admin_dispute_cases"."resolved_amount_satang", "admin_dispute_cases"."resolved_by_admin_id", "admin_dispute_cases"."resolved_at") = 0)
        OR ("admin_dispute_cases"."status" = 'DISPUTE_CASE_DISMISSED' AND num_nonnulls("admin_dispute_cases"."resolved_worker_id", "admin_dispute_cases"."resolved_amount_satang") = 0 AND num_nonnulls("admin_dispute_cases"."resolved_by_admin_id", "admin_dispute_cases"."resolved_at") = 2)
        OR ("admin_dispute_cases"."status" = 'DISPUTE_CASE_RESOLVED' AND num_nonnulls("admin_dispute_cases"."resolved_worker_id", "admin_dispute_cases"."resolved_amount_satang", "admin_dispute_cases"."resolved_by_admin_id", "admin_dispute_cases"."resolved_at") = 4)
      ))
);
--> statement-breakpoint
ALTER TABLE "quest" ADD COLUMN "failed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "quest" SET "failed_at" = "updated_at" WHERE "quest_status" = 'QUEST_FAILED' AND "failed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "admin_dispute_cases" ADD CONSTRAINT "admin_dispute_cases_quest_id_quest_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quest"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_dispute_cases" ADD CONSTRAINT "admin_dispute_cases_filer_user_id_auth_user_id_fk" FOREIGN KEY ("filer_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_dispute_cases" ADD CONSTRAINT "admin_dispute_cases_opened_by_admin_id_auth_admin_id_fk" FOREIGN KEY ("opened_by_admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_dispute_cases" ADD CONSTRAINT "admin_dispute_cases_resolved_worker_id_auth_user_id_fk" FOREIGN KEY ("resolved_worker_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_dispute_cases" ADD CONSTRAINT "admin_dispute_cases_resolved_by_admin_id_auth_admin_id_fk" FOREIGN KEY ("resolved_by_admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_dispute_cases_status_created_idx" ON "admin_dispute_cases" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "admin_dispute_cases_quest_idx" ON "admin_dispute_cases" USING btree ("quest_id","created_at");--> statement-breakpoint
CREATE INDEX "admin_dispute_cases_filer_idx" ON "admin_dispute_cases" USING btree ("filer_user_id");--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_failed_at_check" CHECK (("quest"."failed_at" IS NOT NULL) = ("quest"."quest_status" = 'QUEST_FAILED'));
