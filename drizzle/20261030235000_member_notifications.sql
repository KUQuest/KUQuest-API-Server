CREATE TABLE "member_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"type" varchar(64) NOT NULL,
	"event_key" varchar(200) NOT NULL,
	"quest_id" uuid,
	"result" varchar(32),
	"ladder" varchar(16),
	"source" varchar(32),
	"transition_id" varchar(200),
	"expires_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_notifications_event_key_check" CHECK (btrim("member_notifications"."event_key") <> ''),
	CONSTRAINT "member_notifications_type_check" CHECK ("member_notifications"."type" IN ('PENALTY_RED_FLAG_APPLIED', 'PENALTY_RED_FLAG_EXPIRED', 'PENALTY_BAN_APPLIED', 'PENALTY_BAN_ENDED', 'CONDUCT_REPORT_UPHELD')),
	CONSTRAINT "member_notifications_result_check" CHECK ("member_notifications"."result" IS NULL OR "member_notifications"."result" IN ('RED_FLAG', 'TEMPORARY_BAN', 'PERMANENT_BAN')),
	CONSTRAINT "member_notifications_ladder_check" CHECK ("member_notifications"."ladder" IS NULL OR "member_notifications"."ladder" IN ('MISCONDUCT', 'REVIEW')),
	CONSTRAINT "member_notifications_source_check" CHECK ("member_notifications"."source" IS NULL OR "member_notifications"."source" IN ('REPORT_CASE', 'CONDUCT_REPORT', 'REVIEW_AVERAGE'))
);
--> statement-breakpoint
ALTER TABLE "member_notifications" ADD CONSTRAINT "member_notifications_member_id_auth_user_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "member_notifications_member_event_uidx" ON "member_notifications" USING btree ("member_id","event_key");--> statement-breakpoint
CREATE INDEX "member_notifications_member_newest_idx" ON "member_notifications" USING btree ("member_id","created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "member_notifications_member_unread_idx" ON "member_notifications" USING btree ("member_id") WHERE "member_notifications"."read_at" is null;