CREATE TYPE "public"."quest_mode" AS ENUM('FIRST_COME_FIRST_SERVED', 'CANDIDATE');--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS citext;--> statement-breakpoint
CREATE TYPE "public"."quest_participation" AS ENUM('SINGLE', 'GROUP');--> statement-breakpoint
CREATE TYPE "public"."quest_status" AS ENUM('DRAFT', 'OPEN', 'AWAITING_CONSENT', 'ASSIGNED', 'IN_PROGRESS', 'SUBMITTED', 'APPROVED', 'REWORK', 'COMPLETED', 'CANCELLED', 'DISPUTED', 'HIDDEN', 'UNFILLED');--> statement-breakpoint
CREATE TABLE "payment_payout_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"recipient_type" text NOT NULL,
	"given_name" text NOT NULL,
	"surname" text NOT NULL,
	"relationship" text NOT NULL,
	"account_country" text DEFAULT 'TH' NOT NULL,
	"account_currency" text DEFAULT 'THB' NOT NULL,
	"bank_code" text NOT NULL,
	"account_number" text NOT NULL,
	"account_holder_name" text NOT NULL,
	"routing_type" text NOT NULL,
	"routing_value" text NOT NULL,
	"masked_last_four" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "payment_payout_accounts_recipient_type_check" CHECK ("payment_payout_accounts"."recipient_type" IN ('SELF', 'THIRD_PARTY')),
	CONSTRAINT "payment_payout_accounts_country_currency_check" CHECK ("payment_payout_accounts"."account_country" = 'TH' AND "payment_payout_accounts"."account_currency" = 'THB')
);
--> statement-breakpoint
CREATE TABLE "payment_payout_cancellation_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payout_id" uuid NOT NULL,
	"admin_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"attempt_status" text NOT NULL,
	"provider_response" jsonb,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_payout_cancellation_attempts_status_check" CHECK ("payment_payout_cancellation_attempts"."attempt_status" IN ('PENDING', 'SUCCEEDED', 'FAILED'))
);
--> statement-breakpoint
CREATE TABLE "payment_payout_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"payout_account_id" uuid NOT NULL,
	"policy_revision_id" uuid NOT NULL,
	"receipt_baht" bigint NOT NULL,
	"maximum_fee_baht" bigint NOT NULL,
	"maximum_tax_baht" bigint NOT NULL,
	"maximum_debit_baht" bigint NOT NULL,
	"quoted_fee_satang" bigint NOT NULL,
	"quoted_tax_satang" bigint NOT NULL,
	"quoted_debit_satang" bigint NOT NULL,
	"currency" text DEFAULT 'THB' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_payout_quotes_amount_check" CHECK ("payment_payout_quotes"."receipt_baht" > 0 AND "payment_payout_quotes"."maximum_fee_baht" >= 0 AND "payment_payout_quotes"."maximum_tax_baht" >= 0 AND "payment_payout_quotes"."maximum_debit_baht" = "payment_payout_quotes"."receipt_baht" + "payment_payout_quotes"."maximum_fee_baht" + "payment_payout_quotes"."maximum_tax_baht" AND "payment_payout_quotes"."quoted_fee_satang" >= 0 AND "payment_payout_quotes"."quoted_tax_satang" >= 0 AND "payment_payout_quotes"."quoted_debit_satang" > 0),
	CONSTRAINT "payment_payout_quotes_currency_check" CHECK ("payment_payout_quotes"."currency" = 'THB')
);
--> statement-breakpoint
CREATE TABLE "payment_payout_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payout_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"provider_status" text,
	"actor_user_id" uuid,
	"actor_admin_id" uuid,
	"source" text NOT NULL,
	"reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_payout_status_history_from_status_check" CHECK ("payment_payout_status_history"."from_status" IS NULL OR "payment_payout_status_history"."from_status" IN ('CREATING', 'PENDING', 'AWAITING_RECONCILIATION', 'COMPLETED', 'FAILED', 'CANCELLED')),
	CONSTRAINT "payment_payout_status_history_to_status_check" CHECK ("payment_payout_status_history"."to_status" IN ('CREATING', 'PENDING', 'AWAITING_RECONCILIATION', 'COMPLETED', 'FAILED', 'CANCELLED')),
	CONSTRAINT "payment_payout_status_history_actor_check" CHECK (num_nonnulls("payment_payout_status_history"."actor_user_id", "payment_payout_status_history"."actor_admin_id") <= 1)
);
--> statement-breakpoint
CREATE TABLE "payment_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"payout_account_id" uuid NOT NULL,
	"destination_recipient_type" text NOT NULL,
	"destination_given_name" text NOT NULL,
	"destination_surname" text NOT NULL,
	"destination_relationship" text NOT NULL,
	"destination_account_country" text NOT NULL,
	"destination_account_currency" text NOT NULL,
	"destination_bank_code" text NOT NULL,
	"destination_account_number" text NOT NULL,
	"destination_account_holder_name" text NOT NULL,
	"destination_routing_type" text NOT NULL,
	"destination_routing_value" text NOT NULL,
	"provider" text NOT NULL,
	"provider_reference" text,
	"principal_baht" bigint NOT NULL,
	"maximum_fee_baht" bigint NOT NULL,
	"maximum_tax_baht" bigint NOT NULL,
	"maximum_debit_baht" bigint NOT NULL,
	"actual_fee_satang" bigint,
	"actual_tax_satang" bigint,
	"actual_debit_satang" bigint,
	"currency" text DEFAULT 'THB' NOT NULL,
	"payout_status" text NOT NULL,
	"reserve_ledger_transaction_id" uuid NOT NULL,
	"final_ledger_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_payouts_quote_id_unique" UNIQUE("quote_id"),
	CONSTRAINT "payment_payouts_provider_reference_unique" UNIQUE("provider_reference"),
	CONSTRAINT "payment_payouts_reserve_ledger_transaction_id_unique" UNIQUE("reserve_ledger_transaction_id"),
	CONSTRAINT "payment_payouts_final_ledger_transaction_id_unique" UNIQUE("final_ledger_transaction_id"),
	CONSTRAINT "payment_payouts_status_check" CHECK ("payment_payouts"."payout_status" IN ('CREATING', 'PENDING', 'AWAITING_RECONCILIATION', 'COMPLETED', 'FAILED', 'CANCELLED')),
	CONSTRAINT "payment_payouts_amount_check" CHECK ("payment_payouts"."principal_baht" > 0 AND "payment_payouts"."maximum_fee_baht" >= 0 AND "payment_payouts"."maximum_tax_baht" >= 0 AND "payment_payouts"."maximum_debit_baht" = "payment_payouts"."principal_baht" + "payment_payouts"."maximum_fee_baht" + "payment_payouts"."maximum_tax_baht"),
	CONSTRAINT "payment_payouts_currency_check" CHECK ("payment_payouts"."currency" = 'THB' AND "payment_payouts"."destination_account_country" = 'TH' AND "payment_payouts"."destination_account_currency" = 'THB')
);
--> statement-breakpoint
CREATE TABLE "payment_top_up_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"policy_revision_id" uuid NOT NULL,
	"credit_baht" bigint NOT NULL,
	"charged_fee_baht" bigint NOT NULL,
	"charged_tax_baht" bigint NOT NULL,
	"payment_total_baht" bigint NOT NULL,
	"provider_fee_satang" bigint NOT NULL,
	"provider_tax_satang" bigint NOT NULL,
	"provider_total_satang" bigint NOT NULL,
	"currency" text DEFAULT 'THB' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_top_up_quotes_amount_check" CHECK ("payment_top_up_quotes"."credit_baht" > 0 AND "payment_top_up_quotes"."charged_fee_baht" >= 0 AND "payment_top_up_quotes"."charged_tax_baht" >= 0 AND "payment_top_up_quotes"."payment_total_baht" = "payment_top_up_quotes"."credit_baht" + "payment_top_up_quotes"."charged_fee_baht" + "payment_top_up_quotes"."charged_tax_baht" AND "payment_top_up_quotes"."provider_fee_satang" >= 0 AND "payment_top_up_quotes"."provider_tax_satang" >= 0 AND "payment_top_up_quotes"."provider_total_satang" > 0),
	CONSTRAINT "payment_top_up_quotes_currency_check" CHECK ("payment_top_up_quotes"."currency" = 'THB')
);
--> statement-breakpoint
CREATE TABLE "payment_top_up_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"top_up_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"provider_status" text,
	"actor_user_id" uuid,
	"actor_admin_id" uuid,
	"source" text NOT NULL,
	"reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_top_up_status_history_from_status_check" CHECK ("payment_top_up_status_history"."from_status" IS NULL OR "payment_top_up_status_history"."from_status" IN ('PENDING', 'PAID', 'EXPIRED', 'FAILED')),
	CONSTRAINT "payment_top_up_status_history_to_status_check" CHECK ("payment_top_up_status_history"."to_status" IN ('PENDING', 'PAID', 'EXPIRED', 'FAILED')),
	CONSTRAINT "payment_top_up_status_history_actor_check" CHECK (num_nonnulls("payment_top_up_status_history"."actor_user_id", "payment_top_up_status_history"."actor_admin_id") <= 1)
);
--> statement-breakpoint
CREATE TABLE "payment_top_ups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"internal_reference" text NOT NULL,
	"user_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_reference" text,
	"credit_baht" bigint NOT NULL,
	"charged_fee_baht" bigint NOT NULL,
	"charged_tax_baht" bigint NOT NULL,
	"payment_total_baht" bigint NOT NULL,
	"provider_fee_satang" bigint NOT NULL,
	"provider_tax_satang" bigint NOT NULL,
	"provider_total_satang" bigint NOT NULL,
	"currency" text DEFAULT 'THB' NOT NULL,
	"qr_payload" text,
	"qr_expires_at" timestamp with time zone,
	"top_up_status" text NOT NULL,
	"credited_ledger_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_top_ups_internal_reference_unique" UNIQUE("internal_reference"),
	CONSTRAINT "payment_top_ups_quote_id_unique" UNIQUE("quote_id"),
	CONSTRAINT "payment_top_ups_provider_reference_unique" UNIQUE("provider_reference"),
	CONSTRAINT "payment_top_ups_credited_ledger_transaction_id_unique" UNIQUE("credited_ledger_transaction_id"),
	CONSTRAINT "payment_top_ups_status_check" CHECK ("payment_top_ups"."top_up_status" IN ('PENDING', 'PAID', 'EXPIRED', 'FAILED')),
	CONSTRAINT "payment_top_ups_amount_check" CHECK ("payment_top_ups"."credit_baht" > 0 AND "payment_top_ups"."charged_fee_baht" >= 0 AND "payment_top_ups"."charged_tax_baht" >= 0 AND "payment_top_ups"."payment_total_baht" = "payment_top_ups"."credit_baht" + "payment_top_ups"."charged_fee_baht" + "payment_top_ups"."charged_tax_baht" AND "payment_top_ups"."provider_fee_satang" >= 0 AND "payment_top_ups"."provider_tax_satang" >= 0 AND "payment_top_ups"."provider_total_satang" > 0),
	CONSTRAINT "payment_top_ups_currency_check" CHECK ("payment_top_ups"."currency" = 'THB')
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	CONSTRAINT "tag_name_key" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "proof_submission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quest_id" uuid NOT NULL,
	"hunter_id" uuid,
	"team_id" uuid,
	"submitted_by_user_id" uuid NOT NULL,
	"content" varchar(5000) NOT NULL,
	"submission_status" varchar(32) DEFAULT 'PENDING' NOT NULL,
	"review_note" varchar(1000),
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	CONSTRAINT "proof_submission_owner_check" CHECK (num_nonnulls("proof_submission"."hunter_id", "proof_submission"."team_id") = 1),
	CONSTRAINT "proof_submission_status_check" CHECK ("proof_submission"."submission_status" IN ('PENDING', 'APPROVED', 'REJECTED', 'AUTO_APPROVED'))
);
--> statement-breakpoint
CREATE TABLE "proof_submission_image" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proof_submission_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "proof_submission_image_submission_id_position_key" UNIQUE("proof_submission_id","position")
);
--> statement-breakpoint
CREATE TABLE "quest" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"giver_id" uuid NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" varchar(2000),
	"condition" varchar(4000) NOT NULL,
	"mode" "quest_mode" NOT NULL,
	"participation" "quest_participation" DEFAULT 'SINGLE' NOT NULL,
	"quest_status" "quest_status" DEFAULT 'DRAFT' NOT NULL,
	"reward_satang" integer NOT NULL,
	"tag_id" uuid,
	"headcount" integer DEFAULT 1 NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone,
	"proof_required" boolean DEFAULT true NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	"cancelled_by_admin_id" uuid,
	"hidden_at" timestamp with time zone,
	"hidden_by_admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quest_reward_check" CHECK ("quest"."reward_satang" > 0),
	CONSTRAINT "quest_headcount_check" CHECK ("quest"."headcount" > 0),
	CONSTRAINT "quest_participation_headcount_check" CHECK ("quest"."participation" = 'GROUP' OR "quest"."headcount" = 1),
	CONSTRAINT "quest_due_at_check" CHECK ("quest"."due_at" IS NULL OR "quest"."due_at" > "quest"."start_time"),
	CONSTRAINT "quest_tag_check" CHECK ("quest"."quest_status" = 'DRAFT' OR "quest"."tag_id" IS NOT NULL),
	CONSTRAINT "quest_cancelled_by_check" CHECK (num_nonnulls("quest"."cancelled_by_user_id", "quest"."cancelled_by_admin_id") <= 1),
	CONSTRAINT "quest_cancelled_at_check" CHECK (("quest"."cancelled_at" IS NULL) = ("quest"."quest_status" <> 'CANCELLED')),
	CONSTRAINT "quest_hidden_at_check" CHECK (("quest"."hidden_at" IS NULL) = ("quest"."quest_status" <> 'HIDDEN')),
	CONSTRAINT "quest_hidden_by_check" CHECK (("quest"."hidden_by_admin_id" IS NULL) = ("quest"."hidden_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "quest_application" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quest_id" uuid NOT NULL,
	"hunter_id" uuid NOT NULL,
	"application_status" varchar(32) DEFAULT 'APPLIED' NOT NULL,
	"rework_limit" integer DEFAULT 0 NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quest_application_quest_id_hunter_id_key" UNIQUE("quest_id","hunter_id"),
	CONSTRAINT "quest_application_status_check" CHECK ("quest_application"."application_status" IN ('APPLIED', 'SELECTED', 'REJECTED')),
	CONSTRAINT "quest_application_rework_limit_check" CHECK ("quest_application"."rework_limit" >= 0)
);
--> statement-breakpoint
CREATE TABLE "quest_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quest_id" uuid NOT NULL,
	"hunter_id" uuid NOT NULL,
	"assignment_status" varchar(32) DEFAULT 'ACTIVE' NOT NULL,
	"started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quest_assignment_quest_id_hunter_id_key" UNIQUE("quest_id","hunter_id"),
	CONSTRAINT "quest_assignment_status_check" CHECK ("quest_assignment"."assignment_status" IN ('ACTIVE', 'COMPLETED', 'INCOMPLETE', 'CANCELLED'))
);
--> statement-breakpoint
CREATE TABLE "quest_edit_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quest_id" uuid NOT NULL,
	"edit_request_id" uuid,
	"field_name" varchar(100) NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb,
	"edited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_by_user_id" uuid,
	"edited_by_admin_id" uuid,
	CONSTRAINT "quest_edit_history_editor_check" CHECK (num_nonnulls("quest_edit_history"."edited_by_user_id", "quest_edit_history"."edited_by_admin_id") <= 1)
);
--> statement-breakpoint
CREATE TABLE "quest_edit_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quest_id" uuid NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"proposed_changes" jsonb NOT NULL,
	"request_status" varchar(32) DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "quest_edit_request_status_check" CHECK ("quest_edit_request"."request_status" IN ('PENDING', 'APPROVED', 'REJECTED'))
);
--> statement-breakpoint
CREATE TABLE "quest_edit_request_response" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"decision" varchar(32) NOT NULL,
	"responded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quest_edit_request_response_request_id_user_id_key" UNIQUE("request_id","user_id"),
	CONSTRAINT "quest_edit_request_response_decision_check" CHECK ("quest_edit_request_response"."decision" IN ('APPROVED', 'REJECTED'))
);
--> statement-breakpoint
CREATE TABLE "quest_image" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quest_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "quest_image_quest_id_position_key" UNIQUE("quest_id","position")
);
--> statement-breakpoint
CREATE TABLE "quest_location" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quest_id" uuid NOT NULL,
	"label" varchar(100),
	"address" varchar(500),
	"lat" numeric(9, 6) NOT NULL,
	"lng" numeric(9, 6) NOT NULL,
	"position" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "quest_location_quest_id_position_key" UNIQUE("quest_id","position"),
	CONSTRAINT "quest_location_lat_check" CHECK ("quest_location"."lat" BETWEEN -90 AND 90),
	CONSTRAINT "quest_location_lng_check" CHECK ("quest_location"."lng" BETWEEN -180 AND 180)
);
--> statement-breakpoint
CREATE TABLE "quest_team" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quest_id" uuid NOT NULL,
	"leader_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"team_status" varchar(32) DEFAULT 'FORMING' NOT NULL,
	"rework_limit" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quest_team_status_check" CHECK ("quest_team"."team_status" IN ('FORMING', 'SUBMITTED', 'SELECTED', 'REJECTED')),
	CONSTRAINT "quest_team_rework_limit_check" CHECK ("quest_team"."rework_limit" >= 0)
);
--> statement-breakpoint
CREATE TABLE "quest_team_member" (
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quest_team_member_team_id_user_id_key" UNIQUE("team_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quest_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"reviewee_id" uuid NOT NULL,
	"rating" smallint NOT NULL,
	"comment" varchar(1000) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_quest_reviewer_reviewee_key" UNIQUE("quest_id","reviewer_id","reviewee_id"),
	CONSTRAINT "review_rating_check" CHECK ("review"."rating" BETWEEN 1 AND 5),
	CONSTRAINT "review_participants_check" CHECK ("review"."reviewer_id" <> "review"."reviewee_id")
);
--> statement-breakpoint
ALTER TABLE "auth_user" DROP CONSTRAINT "auth_user_academic_year_check";--> statement-breakpoint
DROP INDEX "auth_admin_email_uidx";--> statement-breakpoint
ALTER TABLE "department" ALTER COLUMN "name" SET DATA TYPE varchar(100);--> statement-breakpoint
ALTER TABLE "faculty" ALTER COLUMN "name" SET DATA TYPE varchar(100);--> statement-breakpoint
ALTER TABLE "occupation" ALTER COLUMN "name" SET DATA TYPE varchar(100);--> statement-breakpoint
ALTER TABLE "auth_account" ALTER COLUMN "id" SET DATA TYPE uuid;--> statement-breakpoint
ALTER TABLE "auth_account" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "auth_account" ALTER COLUMN "user_id" SET DATA TYPE uuid;--> statement-breakpoint
ALTER TABLE "auth_account" ALTER COLUMN "admin_id" SET DATA TYPE uuid;--> statement-breakpoint
ALTER TABLE "auth_account" ALTER COLUMN "account_id" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "auth_account" ALTER COLUMN "provider_id" SET DATA TYPE varchar(100);--> statement-breakpoint
ALTER TABLE "auth_account" ALTER COLUMN "access_token" SET DATA TYPE varchar(8192);--> statement-breakpoint
ALTER TABLE "auth_account" ALTER COLUMN "refresh_token" SET DATA TYPE varchar(8192);--> statement-breakpoint
ALTER TABLE "auth_account" ALTER COLUMN "id_token" SET DATA TYPE varchar(8192);--> statement-breakpoint
ALTER TABLE "auth_account" ALTER COLUMN "scope" SET DATA TYPE varchar(2048);--> statement-breakpoint
ALTER TABLE "auth_account" ALTER COLUMN "password" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "auth_admin" ALTER COLUMN "id" SET DATA TYPE uuid;--> statement-breakpoint
ALTER TABLE "auth_admin" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "auth_admin" ALTER COLUMN "username" SET DATA TYPE varchar(100);--> statement-breakpoint
ALTER TABLE "auth_admin" ALTER COLUMN "email" SET DATA TYPE citext;--> statement-breakpoint
ALTER TABLE "auth_admin" ALTER COLUMN "image" SET DATA TYPE varchar(2048);--> statement-breakpoint
ALTER TABLE "auth_admin" ALTER COLUMN "first_name" SET DATA TYPE varchar(100);--> statement-breakpoint
ALTER TABLE "auth_admin" ALTER COLUMN "last_name" SET DATA TYPE varchar(100);--> statement-breakpoint
ALTER TABLE "auth_session" ALTER COLUMN "id" SET DATA TYPE uuid;--> statement-breakpoint
ALTER TABLE "auth_session" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "auth_session" ALTER COLUMN "user_id" SET DATA TYPE uuid;--> statement-breakpoint
ALTER TABLE "auth_session" ALTER COLUMN "admin_id" SET DATA TYPE uuid;--> statement-breakpoint
ALTER TABLE "auth_session" ALTER COLUMN "token" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "auth_session" ALTER COLUMN "ip_address" SET DATA TYPE inet;--> statement-breakpoint
ALTER TABLE "auth_session" ALTER COLUMN "user_agent" SET DATA TYPE varchar(512);--> statement-breakpoint
ALTER TABLE "auth_user" ALTER COLUMN "id" SET DATA TYPE uuid;--> statement-breakpoint
ALTER TABLE "auth_user" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "auth_user" ALTER COLUMN "email" SET DATA TYPE citext;--> statement-breakpoint
ALTER TABLE "auth_user" ALTER COLUMN "image" SET DATA TYPE varchar(2048);--> statement-breakpoint
ALTER TABLE "auth_user" ALTER COLUMN "first_name" SET DATA TYPE varchar(100);--> statement-breakpoint
ALTER TABLE "auth_user" ALTER COLUMN "last_name" SET DATA TYPE varchar(100);--> statement-breakpoint
ALTER TABLE "auth_user" ALTER COLUMN "bio" SET DATA TYPE varchar(1000);--> statement-breakpoint
ALTER TABLE "auth_user" ALTER COLUMN "student_id" SET DATA TYPE varchar(10);--> statement-breakpoint
ALTER TABLE "auth_user" ALTER COLUMN "telephone" SET DATA TYPE varchar(12);--> statement-breakpoint
ALTER TABLE "auth_user" ALTER COLUMN "terms_version" SET DATA TYPE varchar(50);--> statement-breakpoint
ALTER TABLE "auth_verification" ALTER COLUMN "id" SET DATA TYPE uuid;--> statement-breakpoint
ALTER TABLE "auth_verification" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "auth_verification" ALTER COLUMN "identifier" SET DATA TYPE citext;--> statement-breakpoint
ALTER TABLE "auth_verification" ALTER COLUMN "value" SET DATA TYPE varchar(2048);--> statement-breakpoint
ALTER TABLE "file" ALTER COLUMN "bucket" SET DATA TYPE varchar(63);--> statement-breakpoint
ALTER TABLE "file" ALTER COLUMN "object_key" SET DATA TYPE varchar(1024);--> statement-breakpoint
ALTER TABLE "file" ALTER COLUMN "content_type" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "file" ALTER COLUMN "uploaded_by_user_id" SET DATA TYPE uuid;--> statement-breakpoint
ALTER TABLE "profile_certificate" ALTER COLUMN "user_id" SET DATA TYPE uuid;--> statement-breakpoint
ALTER TABLE "profile_certificate" ALTER COLUMN "name" SET DATA TYPE varchar(200);--> statement-breakpoint
ALTER TABLE "profile_certificate" ALTER COLUMN "issuer" SET DATA TYPE varchar(200);--> statement-breakpoint
ALTER TABLE "profile_portfolio_item" ALTER COLUMN "user_id" SET DATA TYPE uuid;--> statement-breakpoint
ALTER TABLE "profile_portfolio_item" ALTER COLUMN "title" SET DATA TYPE varchar(120);--> statement-breakpoint
ALTER TABLE "profile_portfolio_item" ALTER COLUMN "description" SET DATA TYPE varchar(1000);--> statement-breakpoint
ALTER TABLE "profile_work_experience" ALTER COLUMN "user_id" SET DATA TYPE uuid;--> statement-breakpoint
ALTER TABLE "profile_work_experience" ALTER COLUMN "title" SET DATA TYPE varchar(120);--> statement-breakpoint
ALTER TABLE "profile_work_experience" ALTER COLUMN "employment_type" SET DATA TYPE varchar(50);--> statement-breakpoint
ALTER TABLE "profile_work_experience" ALTER COLUMN "org" SET DATA TYPE varchar(200);--> statement-breakpoint
ALTER TABLE "profile_work_experience" ALTER COLUMN "description" SET DATA TYPE varchar(1000);--> statement-breakpoint
ALTER TABLE "auth_user" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "profile_certificate" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "profile_portfolio_item" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "profile_work_experience" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_payout_accounts" ADD CONSTRAINT "payment_payout_accounts_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_payout_cancellation_attempts" ADD CONSTRAINT "payment_payout_cancellation_attempts_payout_id_payment_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payment_payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_payout_cancellation_attempts" ADD CONSTRAINT "payment_payout_cancellation_attempts_admin_id_auth_admin_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_payout_quotes" ADD CONSTRAINT "payment_payout_quotes_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_payout_quotes" ADD CONSTRAINT "payment_payout_quotes_payout_account_id_payment_payout_accounts_id_fk" FOREIGN KEY ("payout_account_id") REFERENCES "public"."payment_payout_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_payout_quotes" ADD CONSTRAINT "payment_payout_quotes_policy_revision_id_payment_money_policy_revisions_id_fk" FOREIGN KEY ("policy_revision_id") REFERENCES "public"."payment_money_policy_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_payout_status_history" ADD CONSTRAINT "payment_payout_status_history_payout_id_payment_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payment_payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_payout_status_history" ADD CONSTRAINT "payment_payout_status_history_actor_user_id_auth_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_payout_status_history" ADD CONSTRAINT "payment_payout_status_history_actor_admin_id_auth_admin_id_fk" FOREIGN KEY ("actor_admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD CONSTRAINT "payment_payouts_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD CONSTRAINT "payment_payouts_quote_id_payment_payout_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."payment_payout_quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD CONSTRAINT "payment_payouts_payout_account_id_payment_payout_accounts_id_fk" FOREIGN KEY ("payout_account_id") REFERENCES "public"."payment_payout_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD CONSTRAINT "payment_payouts_reserve_ledger_transaction_id_wallet_ledger_transactions_id_fk" FOREIGN KEY ("reserve_ledger_transaction_id") REFERENCES "public"."wallet_ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_payouts" ADD CONSTRAINT "payment_payouts_final_ledger_transaction_id_wallet_ledger_transactions_id_fk" FOREIGN KEY ("final_ledger_transaction_id") REFERENCES "public"."wallet_ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_top_up_quotes" ADD CONSTRAINT "payment_top_up_quotes_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_top_up_quotes" ADD CONSTRAINT "payment_top_up_quotes_policy_revision_id_payment_money_policy_revisions_id_fk" FOREIGN KEY ("policy_revision_id") REFERENCES "public"."payment_money_policy_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_top_up_status_history" ADD CONSTRAINT "payment_top_up_status_history_top_up_id_payment_top_ups_id_fk" FOREIGN KEY ("top_up_id") REFERENCES "public"."payment_top_ups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_top_up_status_history" ADD CONSTRAINT "payment_top_up_status_history_actor_user_id_auth_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_top_up_status_history" ADD CONSTRAINT "payment_top_up_status_history_actor_admin_id_auth_admin_id_fk" FOREIGN KEY ("actor_admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_top_ups" ADD CONSTRAINT "payment_top_ups_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_top_ups" ADD CONSTRAINT "payment_top_ups_quote_id_payment_top_up_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."payment_top_up_quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_top_ups" ADD CONSTRAINT "payment_top_ups_credited_ledger_transaction_id_wallet_ledger_transactions_id_fk" FOREIGN KEY ("credited_ledger_transaction_id") REFERENCES "public"."wallet_ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_submission" ADD CONSTRAINT "proof_submission_quest_id_quest_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quest"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_submission" ADD CONSTRAINT "proof_submission_hunter_id_auth_user_id_fk" FOREIGN KEY ("hunter_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_submission" ADD CONSTRAINT "proof_submission_team_id_quest_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."quest_team"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_submission" ADD CONSTRAINT "proof_submission_submitted_by_user_id_auth_user_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_submission_image" ADD CONSTRAINT "proof_submission_image_proof_submission_id_proof_submission_id_fk" FOREIGN KEY ("proof_submission_id") REFERENCES "public"."proof_submission"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_submission_image" ADD CONSTRAINT "proof_submission_image_file_id_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_giver_id_auth_user_id_fk" FOREIGN KEY ("giver_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_cancelled_by_user_id_auth_user_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_cancelled_by_admin_id_auth_admin_id_fk" FOREIGN KEY ("cancelled_by_admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_hidden_by_admin_id_auth_admin_id_fk" FOREIGN KEY ("hidden_by_admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_application" ADD CONSTRAINT "quest_application_quest_id_quest_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quest"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_application" ADD CONSTRAINT "quest_application_hunter_id_auth_user_id_fk" FOREIGN KEY ("hunter_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_assignment" ADD CONSTRAINT "quest_assignment_quest_id_quest_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quest"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_assignment" ADD CONSTRAINT "quest_assignment_hunter_id_auth_user_id_fk" FOREIGN KEY ("hunter_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_edit_history" ADD CONSTRAINT "quest_edit_history_quest_id_quest_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quest"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_edit_history" ADD CONSTRAINT "quest_edit_history_edit_request_id_quest_edit_request_id_fk" FOREIGN KEY ("edit_request_id") REFERENCES "public"."quest_edit_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_edit_history" ADD CONSTRAINT "quest_edit_history_edited_by_user_id_auth_user_id_fk" FOREIGN KEY ("edited_by_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_edit_history" ADD CONSTRAINT "quest_edit_history_edited_by_admin_id_auth_admin_id_fk" FOREIGN KEY ("edited_by_admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_edit_request" ADD CONSTRAINT "quest_edit_request_quest_id_quest_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quest"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_edit_request" ADD CONSTRAINT "quest_edit_request_requested_by_user_id_auth_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_edit_request_response" ADD CONSTRAINT "quest_edit_request_response_request_id_quest_edit_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."quest_edit_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_edit_request_response" ADD CONSTRAINT "quest_edit_request_response_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_image" ADD CONSTRAINT "quest_image_quest_id_quest_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quest"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_image" ADD CONSTRAINT "quest_image_file_id_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_location" ADD CONSTRAINT "quest_location_quest_id_quest_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quest"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_team" ADD CONSTRAINT "quest_team_quest_id_quest_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quest"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_team" ADD CONSTRAINT "quest_team_leader_id_auth_user_id_fk" FOREIGN KEY ("leader_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_team_member" ADD CONSTRAINT "quest_team_member_team_id_quest_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."quest_team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_team_member" ADD CONSTRAINT "quest_team_member_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_quest_id_quest_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quest"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_reviewer_id_auth_user_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_reviewee_id_auth_user_id_fk" FOREIGN KEY ("reviewee_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_payout_accounts_active_user_uidx" ON "payment_payout_accounts" USING btree ("user_id") WHERE "payment_payout_accounts"."retired_at" IS NULL;--> statement-breakpoint
CREATE INDEX "payment_payout_cancellation_attempts_payout_idx" ON "payment_payout_cancellation_attempts" USING btree ("payout_id","attempted_at");--> statement-breakpoint
CREATE INDEX "payment_payout_quotes_expiry_idx" ON "payment_payout_quotes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "payment_payout_status_history_idx" ON "payment_payout_status_history" USING btree ("payout_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_payouts_active_user_uidx" ON "payment_payouts" USING btree ("user_id") WHERE "payment_payouts"."payout_status" IN ('CREATING', 'PENDING', 'AWAITING_RECONCILIATION');--> statement-breakpoint
CREATE INDEX "payment_top_up_quotes_expiry_idx" ON "payment_top_up_quotes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "payment_top_up_status_history_idx" ON "payment_top_up_status_history" USING btree ("top_up_id","occurred_at");--> statement-breakpoint
CREATE INDEX "payment_top_ups_user_status_idx" ON "payment_top_ups" USING btree ("user_id","top_up_status");--> statement-breakpoint
CREATE INDEX "proof_submission_quest_id_idx" ON "proof_submission" USING btree ("quest_id");--> statement-breakpoint
CREATE INDEX "proof_submission_status_idx" ON "proof_submission" USING btree ("submission_status");--> statement-breakpoint
CREATE INDEX "proof_submission_hunter_id_idx" ON "proof_submission" USING btree ("hunter_id");--> statement-breakpoint
CREATE INDEX "proof_submission_team_id_idx" ON "proof_submission" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "proof_submission_image_submission_idx" ON "proof_submission_image" USING btree ("proof_submission_id");--> statement-breakpoint
CREATE INDEX "quest_giver_id_idx" ON "quest" USING btree ("giver_id");--> statement-breakpoint
CREATE INDEX "quest_status_idx" ON "quest" USING btree ("quest_status");--> statement-breakpoint
CREATE INDEX "quest_mode_idx" ON "quest" USING btree ("mode");--> statement-breakpoint
CREATE INDEX "quest_tag_id_idx" ON "quest" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "quest_start_time_idx" ON "quest" USING btree ("start_time");--> statement-breakpoint
CREATE INDEX "quest_application_quest_id_idx" ON "quest_application" USING btree ("quest_id");--> statement-breakpoint
CREATE INDEX "quest_application_status_idx" ON "quest_application" USING btree ("application_status");--> statement-breakpoint
CREATE UNIQUE INDEX "quest_application_one_selected_uidx" ON "quest_application" USING btree ("quest_id") WHERE "quest_application"."application_status" = 'SELECTED';--> statement-breakpoint
CREATE INDEX "quest_assignment_quest_id_idx" ON "quest_assignment" USING btree ("quest_id");--> statement-breakpoint
CREATE INDEX "quest_assignment_hunter_id_idx" ON "quest_assignment" USING btree ("hunter_id");--> statement-breakpoint
CREATE INDEX "quest_assignment_status_idx" ON "quest_assignment" USING btree ("assignment_status");--> statement-breakpoint
CREATE INDEX "quest_edit_history_quest_idx" ON "quest_edit_history" USING btree ("quest_id","edited_at");--> statement-breakpoint
CREATE INDEX "quest_edit_request_quest_idx" ON "quest_edit_request" USING btree ("quest_id");--> statement-breakpoint
CREATE INDEX "quest_edit_request_response_request_idx" ON "quest_edit_request_response" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "quest_image_quest_id_idx" ON "quest_image" USING btree ("quest_id");--> statement-breakpoint
CREATE INDEX "quest_location_quest_id_idx" ON "quest_location" USING btree ("quest_id");--> statement-breakpoint
CREATE INDEX "quest_team_quest_id_idx" ON "quest_team" USING btree ("quest_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quest_team_one_selected_uidx" ON "quest_team" USING btree ("quest_id") WHERE "quest_team"."team_status" = 'SELECTED';--> statement-breakpoint
CREATE INDEX "quest_team_member_user_id_idx" ON "quest_team_member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "review_quest_id_idx" ON "review" USING btree ("quest_id");--> statement-breakpoint
CREATE INDEX "review_reviewee_id_idx" ON "review" USING btree ("reviewee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_admin_email_uidx" ON "auth_admin" USING btree ("email");--> statement-breakpoint
ALTER TABLE "auth_user" ADD CONSTRAINT "auth_user_academic_year_check" CHECK ("auth_user"."academic_year" IS NULL OR "auth_user"."academic_year" BETWEEN 1000 AND 9999);