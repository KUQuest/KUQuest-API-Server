-- BE-173: this migration is applied after the BE-172 identity cutover. That
-- cutover remaps legacy auth ids to UUIDs before these Quest foreign keys are
-- recreated. The statements below preserve Quest rows while converting the
-- old Quest vocabulary and actor column names.
CREATE TABLE "quest_team_invitation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"invited_user_id" uuid NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"invitation_status" varchar(32) DEFAULT 'INVITATION_PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "quest_team_invitation_status_check" CHECK ("quest_team_invitation"."invitation_status" IN ('INVITATION_PENDING', 'INVITATION_ACCEPTED', 'INVITATION_DECLINED', 'INVITATION_EXPIRED', 'INVITATION_REVOKED')),
	CONSTRAINT "quest_team_invitation_expires_at_check" CHECK ("quest_team_invitation"."expires_at" > "quest_team_invitation"."created_at"),
	CONSTRAINT "quest_team_invitation_responded_at_check" CHECK (("quest_team_invitation"."responded_at" IS NULL) = ("quest_team_invitation"."invitation_status" = 'INVITATION_PENDING'))
);
--> statement-breakpoint
ALTER TABLE "proof_submission" RENAME COLUMN "hunter_id" TO "worker_id";--> statement-breakpoint
ALTER TABLE "quest_application" RENAME COLUMN "hunter_id" TO "worker_id";--> statement-breakpoint
ALTER TABLE "quest_assignment" RENAME COLUMN "hunter_id" TO "worker_id";--> statement-breakpoint
ALTER TABLE "quest" RENAME COLUMN "giver_id" TO "hirer_id";--> statement-breakpoint
ALTER TABLE "proof_submission" ALTER COLUMN "worker_id" SET DATA TYPE uuid USING "worker_id"::uuid;--> statement-breakpoint
ALTER TABLE "quest_application" ALTER COLUMN "worker_id" SET DATA TYPE uuid USING "worker_id"::uuid;--> statement-breakpoint
ALTER TABLE "quest_assignment" ALTER COLUMN "worker_id" SET DATA TYPE uuid USING "worker_id"::uuid;--> statement-breakpoint
ALTER TABLE "quest" ALTER COLUMN "hirer_id" SET DATA TYPE uuid USING "hirer_id"::uuid;--> statement-breakpoint
ALTER TABLE "quest_application" DROP CONSTRAINT "quest_application_quest_id_hunter_id_key";--> statement-breakpoint
ALTER TABLE "quest_assignment" DROP CONSTRAINT "quest_assignment_quest_id_hunter_id_key";--> statement-breakpoint
ALTER TABLE "quest_location" DROP CONSTRAINT "quest_location_quest_id_position_key";--> statement-breakpoint
ALTER TABLE "quest_team_member" DROP CONSTRAINT "quest_team_member_team_id_user_id_key";--> statement-breakpoint
ALTER TABLE "proof_submission" DROP CONSTRAINT "proof_submission_owner_check";--> statement-breakpoint
ALTER TABLE "proof_submission" DROP CONSTRAINT "proof_submission_status_check";--> statement-breakpoint
ALTER TABLE "quest" DROP CONSTRAINT "quest_tag_check";--> statement-breakpoint
ALTER TABLE "quest" DROP CONSTRAINT "quest_cancelled_at_check";--> statement-breakpoint
ALTER TABLE "quest" DROP CONSTRAINT "quest_hidden_at_check";--> statement-breakpoint
ALTER TABLE "quest" DROP CONSTRAINT "quest_participation_headcount_check";--> statement-breakpoint
ALTER TABLE "quest_application" DROP CONSTRAINT "quest_application_status_check";--> statement-breakpoint
ALTER TABLE "quest_assignment" DROP CONSTRAINT "quest_assignment_status_check";--> statement-breakpoint
ALTER TABLE "quest_edit_request" DROP CONSTRAINT "quest_edit_request_status_check";--> statement-breakpoint
ALTER TABLE "quest_edit_request_response" DROP CONSTRAINT "quest_edit_request_response_decision_check";--> statement-breakpoint
ALTER TABLE "quest_location" DROP CONSTRAINT "quest_location_lat_check";--> statement-breakpoint
ALTER TABLE "quest_location" DROP CONSTRAINT "quest_location_lng_check";--> statement-breakpoint
ALTER TABLE "quest_team" DROP CONSTRAINT "quest_team_status_check";--> statement-breakpoint
UPDATE "quest_team" SET "team_status" = CASE "team_status"
  WHEN 'FORMING' THEN 'TEAM_FORMING'
  WHEN 'SUBMITTED' THEN 'TEAM_SUBMITTED'
  WHEN 'SELECTED' THEN 'TEAM_SELECTED'
  WHEN 'REJECTED' THEN 'TEAM_REJECTED'
END;--> statement-breakpoint
UPDATE "quest_application" SET "application_status" = CASE "application_status"
  WHEN 'APPLIED' THEN 'APPLICATION_APPLIED'
  WHEN 'SELECTED' THEN 'APPLICATION_SELECTED'
  WHEN 'REJECTED' THEN 'APPLICATION_REJECTED'
END;--> statement-breakpoint
UPDATE "quest_assignment" SET "assignment_status" = CASE "assignment_status"
  WHEN 'ACTIVE' THEN 'ASSIGNMENT_ACTIVE'
  WHEN 'COMPLETED' THEN 'ASSIGNMENT_COMPLETED'
  WHEN 'INCOMPLETE' THEN 'ASSIGNMENT_INCOMPLETE'
  WHEN 'CANCELLED' THEN 'ASSIGNMENT_CANCELLED'
END;--> statement-breakpoint
UPDATE "proof_submission" SET "submission_status" = CASE "submission_status"
  WHEN 'PENDING' THEN 'PROOF_PENDING'
  WHEN 'APPROVED' THEN 'PROOF_APPROVED'
  WHEN 'REJECTED' THEN 'PROOF_REJECTED'
  WHEN 'AUTO_APPROVED' THEN 'PROOF_AUTO_APPROVED'
END;--> statement-breakpoint
UPDATE "quest_edit_request" SET "request_status" = CASE "request_status"
  WHEN 'PENDING' THEN 'EDIT_REQUEST_PENDING'
  WHEN 'APPROVED' THEN 'EDIT_REQUEST_APPROVED'
  WHEN 'REJECTED' THEN 'EDIT_REQUEST_REJECTED'
END;--> statement-breakpoint
UPDATE "quest_edit_request_response" SET "decision" = CASE "decision"
  WHEN 'APPROVED' THEN 'EDIT_RESPONSE_APPROVED'
  WHEN 'REJECTED' THEN 'EDIT_RESPONSE_REJECTED'
END;--> statement-breakpoint
ALTER TABLE "proof_submission" DROP CONSTRAINT "proof_submission_hunter_id_auth_user_id_fk";
--> statement-breakpoint
ALTER TABLE "quest" DROP CONSTRAINT "quest_giver_id_auth_user_id_fk";
--> statement-breakpoint
ALTER TABLE "quest_application" DROP CONSTRAINT "quest_application_hunter_id_auth_user_id_fk";
--> statement-breakpoint
ALTER TABLE "quest_assignment" DROP CONSTRAINT "quest_assignment_hunter_id_auth_user_id_fk";
--> statement-breakpoint
ALTER TABLE "quest" ALTER COLUMN "mode" SET DATA TYPE text;--> statement-breakpoint
UPDATE "quest" SET "mode" = CASE "mode"
  WHEN 'FIRST_COME_FIRST_SERVED' THEN 'NO_CANDIDATE'
  WHEN 'CANDIDATE' THEN 'CANDIDATE'
END;--> statement-breakpoint
DROP TYPE "public"."quest_mode";--> statement-breakpoint
CREATE TYPE "public"."quest_mode" AS ENUM('NO_CANDIDATE', 'CANDIDATE');--> statement-breakpoint
ALTER TABLE "quest" ALTER COLUMN "mode" SET DATA TYPE "public"."quest_mode" USING "mode"::"public"."quest_mode";--> statement-breakpoint
ALTER TABLE "quest" ALTER COLUMN "participation" SET DATA TYPE text;--> statement-breakpoint
UPDATE "quest" SET "participation" = CASE "participation"
  WHEN 'SINGLE' THEN 'SOLO'
  WHEN 'GROUP' THEN 'GROUP'
END;--> statement-breakpoint
ALTER TABLE "quest" ALTER COLUMN "participation" SET DEFAULT 'SOLO'::text;--> statement-breakpoint
DROP TYPE "public"."quest_participation";--> statement-breakpoint
CREATE TYPE "public"."quest_participation" AS ENUM('SOLO', 'GROUP');--> statement-breakpoint
ALTER TABLE "quest" ALTER COLUMN "participation" SET DEFAULT 'SOLO'::"public"."quest_participation";--> statement-breakpoint
ALTER TABLE "quest" ALTER COLUMN "participation" SET DATA TYPE "public"."quest_participation" USING "participation"::"public"."quest_participation";--> statement-breakpoint
ALTER TABLE "quest" ALTER COLUMN "quest_status" SET DATA TYPE text;--> statement-breakpoint
UPDATE "quest" SET "quest_status" = CASE "quest_status"
  WHEN 'DRAFT' THEN 'QUEST_DRAFT'
  WHEN 'OPEN' THEN 'QUEST_OPEN'
  WHEN 'AWAITING_CONSENT' THEN 'QUEST_AWAITING_CONSENT'
  WHEN 'ASSIGNED' THEN 'QUEST_ASSIGNED'
  WHEN 'IN_PROGRESS' THEN 'QUEST_IN_PROGRESS'
  WHEN 'SUBMITTED' THEN 'QUEST_SUBMITTED'
  WHEN 'APPROVED' THEN 'QUEST_APPROVED'
  WHEN 'REWORK' THEN 'QUEST_REWORK'
  WHEN 'COMPLETED' THEN 'QUEST_COMPLETED'
  WHEN 'CANCELLED' THEN 'QUEST_CANCELLED'
  WHEN 'DISPUTED' THEN 'QUEST_DISPUTED'
  WHEN 'HIDDEN' THEN 'QUEST_HIDDEN'
  WHEN 'UNFILLED' THEN 'QUEST_OPEN'
END;--> statement-breakpoint
ALTER TABLE "quest" ALTER COLUMN "quest_status" SET DEFAULT 'QUEST_DRAFT'::text;--> statement-breakpoint
DROP TYPE "public"."quest_status";--> statement-breakpoint
CREATE TYPE "public"."quest_status" AS ENUM('QUEST_DRAFT', 'QUEST_OPEN', 'QUEST_AWAITING_CONSENT', 'QUEST_ASSIGNED', 'QUEST_IN_PROGRESS', 'QUEST_SUBMITTED', 'QUEST_APPROVED', 'QUEST_REWORK', 'QUEST_COMPLETED', 'QUEST_CANCELLED', 'QUEST_DISPUTED', 'QUEST_HIDDEN');--> statement-breakpoint
ALTER TABLE "quest" ALTER COLUMN "quest_status" SET DEFAULT 'QUEST_DRAFT'::"public"."quest_status";--> statement-breakpoint
ALTER TABLE "quest" ALTER COLUMN "quest_status" SET DATA TYPE "public"."quest_status" USING "quest_status"::"public"."quest_status";--> statement-breakpoint
DROP INDEX "proof_submission_hunter_id_idx";--> statement-breakpoint
DROP INDEX "quest_giver_id_idx";--> statement-breakpoint
DROP INDEX "quest_assignment_hunter_id_idx";--> statement-breakpoint
DROP INDEX "quest_application_one_selected_uidx";--> statement-breakpoint
DROP INDEX "quest_team_one_selected_uidx";--> statement-breakpoint
ALTER TABLE "proof_submission" ALTER COLUMN "submission_status" SET DEFAULT 'PROOF_PENDING';--> statement-breakpoint
ALTER TABLE "quest_application" ALTER COLUMN "application_status" SET DEFAULT 'APPLICATION_APPLIED';--> statement-breakpoint
ALTER TABLE "quest_assignment" ALTER COLUMN "assignment_status" SET DEFAULT 'ASSIGNMENT_ACTIVE';--> statement-breakpoint
ALTER TABLE "quest_edit_request" ALTER COLUMN "request_status" SET DEFAULT 'EDIT_REQUEST_PENDING';--> statement-breakpoint
ALTER TABLE "quest_team" ALTER COLUMN "team_status" SET DEFAULT 'TEAM_FORMING';--> statement-breakpoint
ALTER TABLE "quest_team_member" ADD CONSTRAINT "quest_team_member_team_id_user_id_pk" PRIMARY KEY("team_id","user_id");--> statement-breakpoint

ALTER TABLE "quest_team_invitation" ADD CONSTRAINT "quest_team_invitation_invited_user_id_auth_user_id_fk" FOREIGN KEY ("invited_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_team_invitation" ADD CONSTRAINT "quest_team_invitation_invited_by_user_id_auth_user_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_team_invitation" ADD CONSTRAINT "quest_team_invitation_team_id_invited_by_user_id_quest_team_id_leader_id_fk" FOREIGN KEY ("team_id","invited_by_user_id") REFERENCES "public"."quest_team"("id","leader_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quest_team_invitation_team_id_idx" ON "quest_team_invitation" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "quest_team_invitation_invited_user_id_idx" ON "quest_team_invitation" USING btree ("invited_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quest_team_invitation_one_pending_uidx" ON "quest_team_invitation" USING btree ("team_id","invited_user_id") WHERE "quest_team_invitation"."invitation_status" = 'INVITATION_PENDING';--> statement-breakpoint
ALTER TABLE "proof_submission" ADD CONSTRAINT "proof_submission_worker_id_auth_user_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_hirer_id_auth_user_id_fk" FOREIGN KEY ("hirer_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_application" ADD CONSTRAINT "quest_application_worker_id_auth_user_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_assignment" ADD CONSTRAINT "quest_assignment_worker_id_auth_user_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proof_submission_worker_id_idx" ON "proof_submission" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "quest_hirer_id_idx" ON "quest" USING btree ("hirer_id");--> statement-breakpoint
CREATE INDEX "quest_assignment_worker_id_idx" ON "quest_assignment" USING btree ("worker_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quest_application_one_selected_uidx" ON "quest_application" USING btree ("quest_id") WHERE "quest_application"."application_status" = 'APPLICATION_SELECTED';--> statement-breakpoint
CREATE UNIQUE INDEX "quest_team_one_selected_uidx" ON "quest_team" USING btree ("quest_id") WHERE "quest_team"."team_status" = 'TEAM_SELECTED';--> statement-breakpoint
-- Before this destructive cutover, take the deployment backup required by the
-- runbook. label is retained; address/geocodes/order are legacy extras and are
-- intentionally discarded only after that backup and application cutover.
ALTER TABLE "quest_location" DROP COLUMN "address";--> statement-breakpoint
ALTER TABLE "quest_location" DROP COLUMN "lat";--> statement-breakpoint
ALTER TABLE "quest_location" DROP COLUMN "lng";--> statement-breakpoint
ALTER TABLE "quest_location" DROP COLUMN "position";--> statement-breakpoint
ALTER TABLE "quest_application" ADD CONSTRAINT "quest_application_quest_id_worker_id_key" UNIQUE("quest_id","worker_id");--> statement-breakpoint
ALTER TABLE "quest_assignment" ADD CONSTRAINT "quest_assignment_quest_id_worker_id_key" UNIQUE("quest_id","worker_id");--> statement-breakpoint
ALTER TABLE "quest_team" ADD CONSTRAINT "quest_team_id_leader_id_key" UNIQUE("id","leader_id");--> statement-breakpoint
ALTER TABLE "proof_submission" ADD CONSTRAINT "proof_submission_owner_check" CHECK (num_nonnulls("proof_submission"."worker_id", "proof_submission"."team_id") = 1);--> statement-breakpoint
ALTER TABLE "proof_submission" ADD CONSTRAINT "proof_submission_status_check" CHECK ("proof_submission"."submission_status" IN ('PROOF_PENDING', 'PROOF_APPROVED', 'PROOF_REJECTED', 'PROOF_AUTO_APPROVED'));--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_tag_check" CHECK ("quest"."quest_status" = 'QUEST_DRAFT' OR "quest"."tag_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_participation_headcount_check" CHECK ("quest"."participation" = 'GROUP' OR "quest"."headcount" = 1);--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_cancelled_at_check" CHECK (("quest"."cancelled_at" IS NULL) = ("quest"."quest_status" <> 'QUEST_CANCELLED'));--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_hidden_at_check" CHECK (("quest"."hidden_at" IS NULL) = ("quest"."quest_status" <> 'QUEST_HIDDEN'));--> statement-breakpoint
ALTER TABLE "quest_application" ADD CONSTRAINT "quest_application_status_check" CHECK ("quest_application"."application_status" IN ('APPLICATION_APPLIED', 'APPLICATION_SELECTED', 'APPLICATION_REJECTED', 'APPLICATION_WITHDRAWN'));--> statement-breakpoint
ALTER TABLE "quest_assignment" ADD CONSTRAINT "quest_assignment_status_check" CHECK ("quest_assignment"."assignment_status" IN ('ASSIGNMENT_ACTIVE', 'ASSIGNMENT_COMPLETED', 'ASSIGNMENT_INCOMPLETE', 'ASSIGNMENT_CANCELLED'));--> statement-breakpoint
ALTER TABLE "quest_edit_request" ADD CONSTRAINT "quest_edit_request_status_check" CHECK ("quest_edit_request"."request_status" IN ('EDIT_REQUEST_PENDING', 'EDIT_REQUEST_APPROVED', 'EDIT_REQUEST_REJECTED'));--> statement-breakpoint
ALTER TABLE "quest_edit_request_response" ADD CONSTRAINT "quest_edit_request_response_decision_check" CHECK ("quest_edit_request_response"."decision" IN ('EDIT_RESPONSE_APPROVED', 'EDIT_RESPONSE_REJECTED'));--> statement-breakpoint
ALTER TABLE "quest_team" ADD CONSTRAINT "quest_team_status_check" CHECK ("quest_team"."team_status" IN ('TEAM_FORMING', 'TEAM_SUBMITTED', 'TEAM_SELECTED', 'TEAM_REJECTED'));