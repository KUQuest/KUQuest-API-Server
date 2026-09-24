CREATE TABLE "admin_conduct_report_evidence_handles" (
	"id" varchar(47) PRIMARY KEY NOT NULL,
	"report_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_conduct_report_evidence_handles_report_conversation_key" UNIQUE("report_id","conversation_id"),
	CONSTRAINT "admin_conduct_report_evidence_handles_id_check" CHECK ("admin_conduct_report_evidence_handles"."id" ~ '^CRH_[A-Za-z0-9_-]{43}$')
);
--> statement-breakpoint
ALTER TABLE "admin_conduct_report_evidence_handles" ADD CONSTRAINT "admin_conduct_report_evidence_handles_report_id_admin_conduct_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."admin_conduct_reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_conduct_report_evidence_handles" ADD CONSTRAINT "admin_conduct_report_evidence_handles_conversation_id_chat_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_conduct_report_evidence_handles_conversation_idx" ON "admin_conduct_report_evidence_handles" USING btree ("conversation_id");