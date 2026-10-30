CREATE TABLE "member_penalty_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"ladder" text NOT NULL,
	"source" text NOT NULL,
	"source_id" uuid NOT NULL,
	"sequence_number" integer NOT NULL,
	"result" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_admin_id" uuid,
	"reason_code" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversal_of_record_id" uuid,
	CONSTRAINT "member_penalty_records_ladder_check" CHECK ("member_penalty_records"."ladder" IN ('MISCONDUCT', 'REVIEW')),
	CONSTRAINT "member_penalty_records_source_check" CHECK ("member_penalty_records"."source" IN ('REPORT_CASE', 'CONDUCT_REPORT', 'REVIEW_AVERAGE')),
	CONSTRAINT "member_penalty_records_source_ladder_check" CHECK ((
        ("member_penalty_records"."source" IN ('REPORT_CASE', 'CONDUCT_REPORT') AND "member_penalty_records"."ladder" = 'MISCONDUCT') OR
        ("member_penalty_records"."source" = 'REVIEW_AVERAGE' AND "member_penalty_records"."ladder" = 'REVIEW')
      )),
	CONSTRAINT "member_penalty_records_result_check" CHECK ("member_penalty_records"."result" IN ('PENALTY_EXEMPT', 'PENALTY_RED_FLAG', 'PENALTY_TEMPORARY_BAN_7_DAYS', 'PENALTY_TEMPORARY_BAN_1_MONTH', 'PENALTY_PERMANENT_BAN', 'PENALTY_REVERSAL')),
	CONSTRAINT "member_penalty_records_sequence_check" CHECK ("member_penalty_records"."sequence_number" > 0),
	CONSTRAINT "member_penalty_records_actor_check" CHECK ((
        ("member_penalty_records"."actor_type" = 'ADMIN' AND "member_penalty_records"."actor_admin_id" IS NOT NULL) OR
        ("member_penalty_records"."actor_type" = 'SYSTEM' AND "member_penalty_records"."actor_admin_id" IS NULL)
      )),
	CONSTRAINT "member_penalty_records_reason_code_check" CHECK ("member_penalty_records"."reason_code" ~ '^[A-Z][A-Z0-9_.-]{0,99}$'),
	CONSTRAINT "member_penalty_records_reversal_check" CHECK (("member_penalty_records"."result" = 'PENALTY_REVERSAL') = ("member_penalty_records"."reversal_of_record_id" IS NOT NULL)),
	CONSTRAINT "member_penalty_records_not_self_reversal_check" CHECK ("member_penalty_records"."reversal_of_record_id" IS NULL OR "member_penalty_records"."reversal_of_record_id" <> "member_penalty_records"."id")
);
--> statement-breakpoint
ALTER TABLE "auth_user" ADD COLUMN "banned_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_user" ADD COLUMN "red_flag_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "member_penalty_records" ADD CONSTRAINT "member_penalty_records_member_id_auth_user_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."auth_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_penalty_records" ADD CONSTRAINT "member_penalty_records_actor_admin_id_auth_admin_id_fk" FOREIGN KEY ("actor_admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_penalty_records" ADD CONSTRAINT "member_penalty_records_reversal_of_record_id_member_penalty_records_id_fk" FOREIGN KEY ("reversal_of_record_id") REFERENCES "public"."member_penalty_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "member_penalty_records_reversal_uidx" ON "member_penalty_records" USING btree ("reversal_of_record_id") WHERE "member_penalty_records"."reversal_of_record_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "member_penalty_records_review_source_uidx" ON "member_penalty_records" USING btree ("member_id","source_id") WHERE "member_penalty_records"."source" = 'REVIEW_AVERAGE';--> statement-breakpoint
CREATE INDEX "member_penalty_records_member_created_idx" ON "member_penalty_records" USING btree ("member_id","created_at","id");--> statement-breakpoint
CREATE INDEX "member_penalty_records_member_ladder_idx" ON "member_penalty_records" USING btree ("member_id","ladder","sequence_number");--> statement-breakpoint
CREATE INDEX "member_penalty_records_member_result_idx" ON "member_penalty_records" USING btree ("member_id","result");--> statement-breakpoint
CREATE INDEX "member_penalty_records_source_idx" ON "member_penalty_records" USING btree ("source","source_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION member_penalty_records_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Member Penalty records are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER member_penalty_records_immutable
BEFORE UPDATE OR DELETE ON member_penalty_records
FOR EACH ROW EXECUTE FUNCTION member_penalty_records_reject_mutation();
