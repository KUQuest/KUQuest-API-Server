ALTER TABLE "quest_edit_request_response" DROP CONSTRAINT "quest_edit_request_response_decision_check";--> statement-breakpoint
ALTER TABLE "quest_edit_request_response" ALTER COLUMN "decision" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "quest_edit_request" ADD COLUMN "previous_quest_status" "quest_status" NOT NULL DEFAULT 'QUEST_OPEN';--> statement-breakpoint
ALTER TABLE "quest_edit_request" ALTER COLUMN "previous_quest_status" DROP DEFAULT;--> statement-breakpoint
CREATE UNIQUE INDEX "quest_edit_request_one_pending_uidx" ON "quest_edit_request" USING btree ("quest_id") WHERE "quest_edit_request"."request_status" = 'EDIT_REQUEST_PENDING';--> statement-breakpoint
ALTER TABLE "quest_edit_request_response" ADD CONSTRAINT "quest_edit_request_response_decision_check" CHECK ("quest_edit_request_response"."decision" IN ('EDIT_RESPONSE_APPROVED', 'EDIT_RESPONSE_REJECTED'));ALTER TABLE "quest_edit_request_response" ALTER COLUMN "responded_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "quest_edit_request_response" ALTER COLUMN "responded_at" DROP NOT NULL;
