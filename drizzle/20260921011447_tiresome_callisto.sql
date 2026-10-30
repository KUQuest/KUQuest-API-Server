CREATE TABLE "admin_evidence_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_case_id" uuid NOT NULL,
	"message_id" uuid,
	"attachment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_evidence_references_target_check" CHECK (num_nonnulls("admin_evidence_references"."message_id", "admin_evidence_references"."attachment_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "admin_moderation_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_case_id" uuid NOT NULL,
	"admin_id" uuid NOT NULL,
	"previous_status" text NOT NULL,
	"new_status" text NOT NULL,
	"reason_catalog_version" integer NOT NULL,
	"reason_code" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_moderation_decisions_transition_check" CHECK ((
        ("admin_moderation_decisions"."previous_status" = 'REPORT_CASE_PENDING' AND "admin_moderation_decisions"."new_status" IN ('REPORT_CASE_DISMISSED', 'REPORT_CASE_HIDDEN'))
        OR ("admin_moderation_decisions"."previous_status" = 'REPORT_CASE_HIDDEN' AND "admin_moderation_decisions"."new_status" IN ('REPORT_CASE_DISMISSED', 'REPORT_CASE_HIDDEN', 'REPORT_CASE_RESTORED'))
      )),
	CONSTRAINT "admin_moderation_decisions_reason_catalog_version_check" CHECK ("admin_moderation_decisions"."reason_catalog_version" >= 1),
	CONSTRAINT "admin_moderation_decisions_reason_code_check" CHECK ("admin_moderation_decisions"."reason_code" ~ '^[A-Z][A-Z0-9_.-]{0,99}$')
);
--> statement-breakpoint
CREATE TABLE "admin_report_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"status" text DEFAULT 'REPORT_CASE_PENDING' NOT NULL,
	"case_closed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_report_cases_id_message_key" UNIQUE("id","message_id"),
	CONSTRAINT "admin_report_cases_status_check" CHECK ("admin_report_cases"."status" IN ('REPORT_CASE_PENDING', 'REPORT_CASE_DISMISSED', 'REPORT_CASE_HIDDEN', 'REPORT_CASE_RESTORED')),
	CONSTRAINT "admin_report_cases_version_check" CHECK ("admin_report_cases"."version" >= 1),
	CONSTRAINT "admin_report_cases_closed_time_check" CHECK ((
        ("admin_report_cases"."status" IN ('REPORT_CASE_PENDING', 'REPORT_CASE_HIDDEN') AND "admin_report_cases"."case_closed_at" IS NULL)
        OR ("admin_report_cases"."status" IN ('REPORT_CASE_DISMISSED', 'REPORT_CASE_RESTORED') AND "admin_report_cases"."case_closed_at" IS NOT NULL)
      )),
	CONSTRAINT "admin_report_cases_closed_after_created_check" CHECK ("admin_report_cases"."case_closed_at" IS NULL OR "admin_report_cases"."case_closed_at" >= "admin_report_cases"."created_at")
);
--> statement-breakpoint
CREATE TABLE "admin_reporter_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_case_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"reporter_member_id" uuid NOT NULL,
	"reason" varchar(64) NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_reporter_entries_message_reporter_key" UNIQUE("message_id","reporter_member_id"),
	CONSTRAINT "admin_reporter_entries_reason_check" CHECK ("admin_reporter_entries"."reason" = 'REPORT_ABUSIVE_OR_HARASSMENT'),
	CONSTRAINT "admin_reporter_entries_detail_check" CHECK ("admin_reporter_entries"."detail" IS NULL OR btrim("admin_reporter_entries"."detail") <> '')
);
--> statement-breakpoint
ALTER TABLE "admin_evidence_references" ADD CONSTRAINT "admin_evidence_references_report_case_id_admin_report_cases_id_fk" FOREIGN KEY ("report_case_id") REFERENCES "public"."admin_report_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_evidence_references" ADD CONSTRAINT "admin_evidence_references_message_id_chat_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_message"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_evidence_references" ADD CONSTRAINT "admin_evidence_references_attachment_id_chat_attachment_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."chat_attachment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_moderation_decisions" ADD CONSTRAINT "admin_moderation_decisions_report_case_id_admin_report_cases_id_fk" FOREIGN KEY ("report_case_id") REFERENCES "public"."admin_report_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_moderation_decisions" ADD CONSTRAINT "admin_moderation_decisions_admin_id_auth_admin_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_report_cases" ADD CONSTRAINT "admin_report_cases_message_id_chat_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_message"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_reporter_entries" ADD CONSTRAINT "admin_reporter_entries_reporter_member_id_auth_user_id_fk" FOREIGN KEY ("reporter_member_id") REFERENCES "public"."auth_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_reporter_entries" ADD CONSTRAINT "admin_reporter_entries_case_message_fk" FOREIGN KEY ("report_case_id","message_id") REFERENCES "public"."admin_report_cases"("id","message_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_evidence_references_case_message_uidx" ON "admin_evidence_references" USING btree ("report_case_id","message_id") WHERE "admin_evidence_references"."message_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_evidence_references_case_attachment_uidx" ON "admin_evidence_references" USING btree ("report_case_id","attachment_id") WHERE "admin_evidence_references"."attachment_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "admin_evidence_references_case_created_idx" ON "admin_evidence_references" USING btree ("report_case_id","created_at","id");--> statement-breakpoint
CREATE INDEX "admin_moderation_decisions_case_created_idx" ON "admin_moderation_decisions" USING btree ("report_case_id","created_at","id");--> statement-breakpoint
CREATE INDEX "admin_moderation_decisions_admin_created_idx" ON "admin_moderation_decisions" USING btree ("admin_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_report_cases_one_open_message_uidx" ON "admin_report_cases" USING btree ("message_id") WHERE "admin_report_cases"."status" IN ('REPORT_CASE_PENDING', 'REPORT_CASE_HIDDEN');--> statement-breakpoint
CREATE INDEX "admin_report_cases_status_created_idx" ON "admin_report_cases" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "admin_report_cases_message_created_idx" ON "admin_report_cases" USING btree ("message_id","created_at","id");--> statement-breakpoint
CREATE INDEX "admin_reporter_entries_case_created_idx" ON "admin_reporter_entries" USING btree ("report_case_id","created_at","id");--> statement-breakpoint
CREATE INDEX "admin_reporter_entries_reporter_idx" ON "admin_reporter_entries" USING btree ("reporter_member_id","created_at");