CREATE TABLE "admin_conduct_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quest_id" uuid NOT NULL,
	"filer_user_id" uuid NOT NULL,
	"reported_member_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"reason" varchar(64) NOT NULL,
	"detail" text,
	"status" text DEFAULT 'CONDUCT_REPORT_PENDING' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"decision_reason" varchar(1000),
	"resolved_by_admin_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_conduct_reports_quest_reported_member_key" UNIQUE("quest_id","reported_member_id"),
	CONSTRAINT "admin_conduct_reports_reason_check" CHECK ("admin_conduct_reports"."reason" IN ('CONDUCT_ABANDONED', 'CONDUCT_OUT_OF_SCOPE', 'CONDUCT_NO_SHOW')),
	CONSTRAINT "admin_conduct_reports_status_check" CHECK ("admin_conduct_reports"."status" IN ('CONDUCT_REPORT_PENDING', 'CONDUCT_REPORT_UPHELD', 'CONDUCT_REPORT_DISMISSED')),
	CONSTRAINT "admin_conduct_reports_version_check" CHECK ("admin_conduct_reports"."version" >= 1),
	CONSTRAINT "admin_conduct_reports_members_check" CHECK ("admin_conduct_reports"."filer_user_id" <> "admin_conduct_reports"."reported_member_id"),
	CONSTRAINT "admin_conduct_reports_detail_check" CHECK ("admin_conduct_reports"."detail" IS NULL OR btrim("admin_conduct_reports"."detail") <> ''),
	CONSTRAINT "admin_conduct_reports_decision_reason_check" CHECK ("admin_conduct_reports"."decision_reason" IS NULL OR btrim("admin_conduct_reports"."decision_reason") <> ''),
	CONSTRAINT "admin_conduct_reports_resolution_check" CHECK ((
        ("admin_conduct_reports"."status" = 'CONDUCT_REPORT_PENDING' AND num_nonnulls("admin_conduct_reports"."decision_reason", "admin_conduct_reports"."resolved_by_admin_id", "admin_conduct_reports"."resolved_at") = 0)
        OR ("admin_conduct_reports"."status" IN ('CONDUCT_REPORT_UPHELD', 'CONDUCT_REPORT_DISMISSED') AND num_nonnulls("admin_conduct_reports"."decision_reason", "admin_conduct_reports"."resolved_by_admin_id", "admin_conduct_reports"."resolved_at") = 3)
      )),
	CONSTRAINT "admin_conduct_reports_resolved_after_created_check" CHECK ("admin_conduct_reports"."resolved_at" IS NULL OR "admin_conduct_reports"."resolved_at" >= "admin_conduct_reports"."created_at")
);
--> statement-breakpoint
ALTER TABLE "admin_conduct_reports" ADD CONSTRAINT "admin_conduct_reports_quest_id_quest_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quest"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_conduct_reports" ADD CONSTRAINT "admin_conduct_reports_filer_user_id_auth_user_id_fk" FOREIGN KEY ("filer_user_id") REFERENCES "public"."auth_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_conduct_reports" ADD CONSTRAINT "admin_conduct_reports_reported_member_id_auth_user_id_fk" FOREIGN KEY ("reported_member_id") REFERENCES "public"."auth_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_conduct_reports" ADD CONSTRAINT "admin_conduct_reports_assignment_id_quest_assignment_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."quest_assignment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_conduct_reports" ADD CONSTRAINT "admin_conduct_reports_resolved_by_admin_id_auth_admin_id_fk" FOREIGN KEY ("resolved_by_admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_conduct_reports_status_created_idx" ON "admin_conduct_reports" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "admin_conduct_reports_quest_created_idx" ON "admin_conduct_reports" USING btree ("quest_id","created_at","id");--> statement-breakpoint
CREATE INDEX "admin_conduct_reports_filer_created_idx" ON "admin_conduct_reports" USING btree ("filer_user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "admin_conduct_reports_reported_member_created_idx" ON "admin_conduct_reports" USING btree ("reported_member_id","created_at","id");--> statement-breakpoint
CREATE INDEX "admin_conduct_reports_assignment_idx" ON "admin_conduct_reports" USING btree ("assignment_id");