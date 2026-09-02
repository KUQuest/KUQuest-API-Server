CREATE TABLE "quest_v2_edit_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quest_id" uuid NOT NULL,
	"previous_condition" jsonb NOT NULL,
	"proposed_condition" jsonb NOT NULL,
	"request_status" varchar(32) DEFAULT 'EDIT_REQUEST_PENDING' NOT NULL,
	"failure_code" varchar(32),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"applied_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	CONSTRAINT "quest_v2_edit_request_status_check" CHECK ("quest_v2_edit_request"."request_status" IN ('EDIT_REQUEST_PENDING', 'EDIT_REQUEST_APPLIED', 'EDIT_REQUEST_FAILED')),
	CONSTRAINT "quest_v2_edit_request_failure_code_check" CHECK ("quest_v2_edit_request"."failure_code" IS NULL OR "quest_v2_edit_request"."failure_code" IN ('EDIT_REQUEST_DECLINED', 'EDIT_REQUEST_TIMEOUT', 'ACTIVE_WORKER_LEFT')),
	CONSTRAINT "quest_v2_edit_request_expiry_check" CHECK ("quest_v2_edit_request"."expires_at" > "quest_v2_edit_request"."created_at"),
	CONSTRAINT "quest_v2_edit_request_applied_at_check" CHECK (("quest_v2_edit_request"."applied_at" IS NOT NULL) = ("quest_v2_edit_request"."request_status" = 'EDIT_REQUEST_APPLIED')),
	CONSTRAINT "quest_v2_edit_request_failed_at_check" CHECK (("quest_v2_edit_request"."failed_at" IS NOT NULL) = ("quest_v2_edit_request"."request_status" = 'EDIT_REQUEST_FAILED')),
	CONSTRAINT "quest_v2_edit_request_failure_status_check" CHECK (("quest_v2_edit_request"."failure_code" IS NOT NULL) = ("quest_v2_edit_request"."request_status" = 'EDIT_REQUEST_FAILED'))
);
--> statement-breakpoint
CREATE TABLE "quest_v2_edit_request_response" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"decision" varchar(32),
	"reason" varchar(255),
	"responded_at" timestamp with time zone,
	CONSTRAINT "quest_v2_edit_request_response_request_worker_key" UNIQUE("request_id","worker_id"),
	CONSTRAINT "quest_v2_edit_request_response_decision_check" CHECK ("quest_v2_edit_request_response"."decision" IS NULL OR "quest_v2_edit_request_response"."decision" IN ('EDIT_RESPONSE_ACCEPTED', 'EDIT_RESPONSE_DECLINED')),
	CONSTRAINT "quest_v2_edit_request_response_reason_check" CHECK ("quest_v2_edit_request_response"."reason" IS NULL OR ("quest_v2_edit_request_response"."decision" = 'EDIT_RESPONSE_DECLINED' AND btrim("quest_v2_edit_request_response"."reason") <> '')),
	CONSTRAINT "quest_v2_edit_request_response_responded_at_check" CHECK (("quest_v2_edit_request_response"."responded_at" IS NOT NULL) = ("quest_v2_edit_request_response"."decision" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "quest_v2_edit_request" ADD CONSTRAINT "quest_v2_edit_request_quest_id_quest_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quest"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_v2_edit_request_response" ADD CONSTRAINT "quest_v2_edit_request_response_request_id_quest_v2_edit_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."quest_v2_edit_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_v2_edit_request_response" ADD CONSTRAINT "quest_v2_edit_request_response_worker_id_auth_user_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quest_v2_edit_request_quest_idx" ON "quest_v2_edit_request" USING btree ("quest_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quest_v2_edit_request_one_pending_uidx" ON "quest_v2_edit_request" USING btree ("quest_id") WHERE "quest_v2_edit_request"."request_status" = 'EDIT_REQUEST_PENDING';--> statement-breakpoint
CREATE INDEX "quest_v2_edit_request_response_request_idx" ON "quest_v2_edit_request_response" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "quest_v2_edit_request_response_worker_idx" ON "quest_v2_edit_request_response" USING btree ("worker_id");