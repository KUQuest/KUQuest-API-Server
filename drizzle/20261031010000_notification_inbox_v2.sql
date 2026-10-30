ALTER TABLE "member_notifications" DROP CONSTRAINT "member_notifications_type_check";--> statement-breakpoint
DROP INDEX "member_notifications_member_newest_idx";--> statement-breakpoint
DROP INDEX "member_notifications_member_unread_idx";--> statement-breakpoint
ALTER TABLE "member_notifications" ADD COLUMN "quest_title" varchar(200);--> statement-breakpoint
ALTER TABLE "member_notifications" ADD COLUMN "actor_role" varchar(16);--> statement-breakpoint
ALTER TABLE "member_notifications" ADD COLUMN "cancellation_reason" varchar(32);--> statement-breakpoint
ALTER TABLE "member_notifications" ADD COLUMN "failure_reason" varchar(32);--> statement-breakpoint
ALTER TABLE "member_notifications" ADD COLUMN "assignment_id" uuid;--> statement-breakpoint
ALTER TABLE "member_notifications" ADD COLUMN "dispute_case_id" uuid;--> statement-breakpoint
ALTER TABLE "member_notifications" ADD COLUMN "dispute_status" varchar(32);--> statement-breakpoint
ALTER TABLE "member_notifications" ADD COLUMN "viewer_won" boolean;--> statement-breakpoint
ALTER TABLE "member_notifications" ADD COLUMN "dismissed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "member_notifications_member_newest_idx" ON "member_notifications" USING btree ("member_id","created_at" desc,"id" desc) WHERE "member_notifications"."dismissed_at" is null;--> statement-breakpoint
CREATE INDEX "member_notifications_member_unread_idx" ON "member_notifications" USING btree ("member_id") WHERE "member_notifications"."read_at" is null and "member_notifications"."dismissed_at" is null;--> statement-breakpoint
ALTER TABLE "member_notifications" ADD CONSTRAINT "member_notifications_actor_role_check" CHECK ("member_notifications"."actor_role" IS NULL OR "member_notifications"."actor_role" IN ('HIRER', 'WORKER'));--> statement-breakpoint
ALTER TABLE "member_notifications" ADD CONSTRAINT "member_notifications_cancellation_reason_check" CHECK ("member_notifications"."cancellation_reason" IS NULL OR "member_notifications"."cancellation_reason" IN ('HIRER_CANCELLED', 'HIRER_NO_DECISION', 'WORKER_DECLINED', 'CONSENT_TIMEOUT'));--> statement-breakpoint
ALTER TABLE "member_notifications" ADD CONSTRAINT "member_notifications_failure_reason_check" CHECK ("member_notifications"."failure_reason" IS NULL OR "member_notifications"."failure_reason" IN ('PROOF_NOT_APPROVED', 'COMPLETION_NOT_APPROVED', 'DUE_AT_MISSED'));--> statement-breakpoint
ALTER TABLE "member_notifications" ADD CONSTRAINT "member_notifications_dispute_status_check" CHECK ("member_notifications"."dispute_status" IS NULL OR "member_notifications"."dispute_status" IN ('DISPUTE_CASE_DISMISSED', 'DISPUTE_CASE_RESOLVED'));--> statement-breakpoint
ALTER TABLE "member_notifications" ADD CONSTRAINT "member_notifications_type_check" CHECK ("member_notifications"."type" IN ('PENALTY_RED_FLAG_APPLIED', 'PENALTY_RED_FLAG_EXPIRED', 'PENALTY_BAN_APPLIED', 'PENALTY_BAN_ENDED', 'CONDUCT_REPORT_UPHELD', 'UNDERFILLED_DECISION_PENDING', 'UNDERFILLED_CONSENT_PENDING', 'UNDERFILLED_COMPLETED', 'UNDERFILLED_CANCELLED', 'QUEST_ASSIGNED', 'PROOF_NOT_APPROVED', 'QUEST_COMPLETED_DISPUTE_WINDOW_OPEN', 'QUEST_FAILED', 'DISPUTE_CASE_FILED_AGAINST_YOU', 'DISPUTE_CASE_DECIDED'));