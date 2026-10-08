ALTER TABLE "member_penalty_records" DROP CONSTRAINT "member_penalty_records_source_check";--> statement-breakpoint
ALTER TABLE "member_penalty_records" DROP CONSTRAINT "member_penalty_records_source_ladder_check";--> statement-breakpoint
DROP INDEX "member_penalty_records_review_source_uidx";--> statement-breakpoint
DROP INDEX "member_penalty_records_violation_source_uidx";--> statement-breakpoint
ALTER TABLE "member_penalty_records" ADD COLUMN "admin_note" varchar(200);--> statement-breakpoint
ALTER TABLE "member_penalty_records" ADD COLUMN "recalculation_of_record_id" uuid;--> statement-breakpoint
ALTER TABLE "member_penalty_records" ADD COLUMN "command_kind" text;--> statement-breakpoint
ALTER TABLE "member_penalty_records" ADD COLUMN "command_request_key" text;--> statement-breakpoint
ALTER TABLE "member_penalty_records" ADD COLUMN "command_request_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "member_penalty_records" ADD COLUMN "command_expected_version_token" integer;--> statement-breakpoint
ALTER TABLE "member_penalty_records" ADD COLUMN "command_result_version_token" integer;--> statement-breakpoint
ALTER TABLE "member_penalty_records" ADD CONSTRAINT "member_penalty_records_recalculation_of_record_id_member_penalty_records_id_fk" FOREIGN KEY ("recalculation_of_record_id") REFERENCES "public"."member_penalty_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "member_penalty_records_recalculation_uidx" ON "member_penalty_records" USING btree ("recalculation_of_record_id") WHERE "member_penalty_records"."recalculation_of_record_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "member_penalty_records_command_request_uidx" ON "member_penalty_records" USING btree ("actor_admin_id","command_kind","command_request_key") WHERE "member_penalty_records"."command_request_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "member_penalty_records_review_source_uidx" ON "member_penalty_records" USING btree ("member_id","source_id") WHERE "member_penalty_records"."source" = 'REVIEW_AVERAGE' AND "member_penalty_records"."result" <> 'PENALTY_REVERSAL' AND "member_penalty_records"."recalculation_of_record_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "member_penalty_records_violation_source_uidx" ON "member_penalty_records" USING btree ("member_id","source","source_id") WHERE "member_penalty_records"."source" IN ('REPORT_CASE', 'CONDUCT_REPORT') AND "member_penalty_records"."result" <> 'PENALTY_REVERSAL' AND "member_penalty_records"."recalculation_of_record_id" IS NULL;--> statement-breakpoint
ALTER TABLE "member_penalty_records" ADD CONSTRAINT "member_penalty_records_not_self_recalculation_check" CHECK ("member_penalty_records"."recalculation_of_record_id" IS NULL OR "member_penalty_records"."recalculation_of_record_id" <> "member_penalty_records"."id");--> statement-breakpoint
ALTER TABLE "member_penalty_records" ADD CONSTRAINT "member_penalty_records_admin_note_check" CHECK ("member_penalty_records"."admin_note" IS NULL OR btrim("member_penalty_records"."admin_note") <> '');--> statement-breakpoint
ALTER TABLE "member_penalty_records" ADD CONSTRAINT "member_penalty_records_command_check" CHECK ((
        num_nonnulls(
          "member_penalty_records"."command_kind",
          "member_penalty_records"."command_request_key",
          "member_penalty_records"."command_request_hash",
          "member_penalty_records"."command_expected_version_token",
          "member_penalty_records"."command_result_version_token"
        ) = 0 OR (
          num_nonnulls(
            "member_penalty_records"."command_kind",
            "member_penalty_records"."command_request_key",
            "member_penalty_records"."command_request_hash",
            "member_penalty_records"."command_expected_version_token",
            "member_penalty_records"."command_result_version_token"
          ) = 5 AND
          "member_penalty_records"."command_kind" IN ('ADD', 'REMOVE') AND
          btrim("member_penalty_records"."command_request_key") <> '' AND
          "member_penalty_records"."command_request_hash" ~ '^[0-9a-f]{64}$' AND
          "member_penalty_records"."command_expected_version_token" >= 0 AND
          "member_penalty_records"."command_result_version_token" >= 1 AND
          "member_penalty_records"."actor_type" = 'ADMIN' AND
          (("member_penalty_records"."command_kind" = 'ADD' AND "member_penalty_records"."source" = 'ADMIN' AND "member_penalty_records"."result" <> 'PENALTY_REVERSAL') OR
           ("member_penalty_records"."command_kind" = 'REMOVE' AND "member_penalty_records"."result" = 'PENALTY_REVERSAL'))
        )
      ));--> statement-breakpoint
ALTER TABLE "member_penalty_records" ADD CONSTRAINT "member_penalty_records_source_check" CHECK ("member_penalty_records"."source" IN ('REPORT_CASE', 'CONDUCT_REPORT', 'REVIEW_AVERAGE', 'ADMIN'));--> statement-breakpoint
ALTER TABLE "member_penalty_records" ADD CONSTRAINT "member_penalty_records_source_ladder_check" CHECK ((
        ("member_penalty_records"."source" IN ('REPORT_CASE', 'CONDUCT_REPORT') AND "member_penalty_records"."ladder" = 'MISCONDUCT') OR
        ("member_penalty_records"."source" = 'REVIEW_AVERAGE' AND "member_penalty_records"."ladder" = 'REVIEW') OR
        ("member_penalty_records"."source" = 'ADMIN' AND "member_penalty_records"."ladder" = 'MISCONDUCT')
      ));