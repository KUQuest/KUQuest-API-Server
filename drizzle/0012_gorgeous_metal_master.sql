CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS citext;--> statement-breakpoint
CREATE TYPE "public"."quest_mode" AS ENUM('NO_CANDIDATE', 'CANDIDATE');--> statement-breakpoint
CREATE TYPE "public"."quest_participation" AS ENUM('SOLO', 'GROUP');--> statement-breakpoint
CREATE TYPE "public"."quest_status" AS ENUM('DRAFT', 'OPEN', 'ASSIGNED', 'IN_PROGRESS', 'SUBMITTED', 'APPROVED', 'REWORK', 'COMPLETED', 'CANCELLED', 'DISPUTED', 'HIDDEN');--> statement-breakpoint
CREATE TABLE "payment_money_policy_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision" bigint NOT NULL,
	"minimum_top_up_baht" bigint NOT NULL,
	"maximum_top_up_baht" bigint NOT NULL,
	"minimum_funded_job_baht" bigint NOT NULL,
	"maximum_funded_job_baht" bigint NOT NULL,
	"minimum_earnings_conversion_baht" bigint NOT NULL,
	"maximum_earnings_conversion_baht" bigint NOT NULL,
	"minimum_payout_baht" bigint NOT NULL,
	"maximum_payout_baht" bigint NOT NULL,
	"platform_fee_bps" smallint NOT NULL,
	"top_up_provider_fee_satang" bigint DEFAULT 0 NOT NULL,
	"top_up_provider_tax_bps" smallint DEFAULT 0 NOT NULL,
	"payout_provider_fee_satang" bigint DEFAULT 0 NOT NULL,
	"payout_provider_tax_bps" smallint DEFAULT 0 NOT NULL,
	"dispute_two_person_threshold_baht" bigint NOT NULL,
	"quote_lifetime_seconds" bigint NOT NULL,
	"review_window_seconds" bigint NOT NULL,
	"default_application_window_seconds" bigint NOT NULL,
	"authored_by_admin_id" uuid,
	"reason" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_money_policy_revisions_revision_unique" UNIQUE("revision"),
	CONSTRAINT "payment_money_policy_revisions_amount_range_check" CHECK ("payment_money_policy_revisions"."minimum_top_up_baht" > 0 AND "payment_money_policy_revisions"."maximum_top_up_baht" >= "payment_money_policy_revisions"."minimum_top_up_baht" AND "payment_money_policy_revisions"."minimum_funded_job_baht" > 0 AND "payment_money_policy_revisions"."maximum_funded_job_baht" >= "payment_money_policy_revisions"."minimum_funded_job_baht" AND "payment_money_policy_revisions"."minimum_earnings_conversion_baht" > 0 AND "payment_money_policy_revisions"."maximum_earnings_conversion_baht" >= "payment_money_policy_revisions"."minimum_earnings_conversion_baht" AND "payment_money_policy_revisions"."minimum_payout_baht" > 0 AND "payment_money_policy_revisions"."maximum_payout_baht" >= "payment_money_policy_revisions"."minimum_payout_baht"),
	CONSTRAINT "payment_money_policy_revisions_fee_check" CHECK ("payment_money_policy_revisions"."platform_fee_bps" BETWEEN 0 AND 10000 AND "payment_money_policy_revisions"."top_up_provider_fee_satang" >= 0 AND "payment_money_policy_revisions"."top_up_provider_tax_bps" BETWEEN 0 AND 10000 AND "payment_money_policy_revisions"."payout_provider_fee_satang" >= 0 AND "payment_money_policy_revisions"."payout_provider_tax_bps" BETWEEN 0 AND 10000),
	CONSTRAINT "payment_money_policy_revisions_duration_check" CHECK ("payment_money_policy_revisions"."quote_lifetime_seconds" > 0 AND "payment_money_policy_revisions"."review_window_seconds" > 0 AND "payment_money_policy_revisions"."default_application_window_seconds" > 0),
	CONSTRAINT "payment_money_policy_revisions_effective_range_check" CHECK ("payment_money_policy_revisions"."effective_until" IS NULL OR "payment_money_policy_revisions"."effective_until" > "payment_money_policy_revisions"."effective_from")
);
--> statement-breakpoint
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
	"participation" "quest_participation" DEFAULT 'SOLO' NOT NULL,
	"quest_status" "quest_status" DEFAULT 'DRAFT' NOT NULL,
	"wage_baht" bigint NOT NULL,
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
	CONSTRAINT "quest_wage_check" CHECK ("quest"."wage_baht" > 0),
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
CREATE TABLE "wallet_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"activity_status" text NOT NULL,
	"spending_delta_baht" bigint DEFAULT 0 NOT NULL,
	"earnings_delta_baht" bigint DEFAULT 0 NOT NULL,
	"job_held_delta_baht" bigint DEFAULT 0 NOT NULL,
	"payout_reserved_delta_baht" bigint DEFAULT 0 NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_activities_type_check" CHECK ("wallet_activities"."type" IN ('TOP_UP', 'SPEND', 'EARN', 'HOLD', 'RELEASE')),
	CONSTRAINT "wallet_activities_status_check" CHECK ("wallet_activities"."activity_status" IN ('PENDING', 'COMPLETED', 'FAILED'))
);
--> statement-breakpoint
CREATE TABLE "wallet_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"admin_id" uuid NOT NULL,
	"compartment" text NOT NULL,
	"amount_baht" bigint NOT NULL,
	"reason" text NOT NULL,
	"ledger_transaction_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_adjustments_ledger_transaction_id_unique" UNIQUE("ledger_transaction_id"),
	CONSTRAINT "wallet_adjustments_compartment_check" CHECK ("wallet_adjustments"."compartment" IN ('SPENDING', 'EARNINGS', 'HELD_FOR_JOBS', 'RESERVED_FOR_PAYOUTS')),
	CONSTRAINT "wallet_adjustments_amount_check" CHECK ("wallet_adjustments"."amount_baht" <> 0)
);
--> statement-breakpoint
CREATE TABLE "wallet_amounts_owed" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_baht" bigint NOT NULL,
	"recovered_baht" bigint DEFAULT 0 NOT NULL,
	"reason" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text,
	"owed_status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_amounts_owed_status_check" CHECK ("wallet_amounts_owed"."owed_status" IN ('OUTSTANDING', 'RECOVERED', 'WRITTEN_OFF')),
	CONSTRAINT "wallet_amounts_owed_range_check" CHECK ("wallet_amounts_owed"."amount_baht" > 0 AND "wallet_amounts_owed"."recovered_baht" >= 0 AND "wallet_amounts_owed"."recovered_baht" <= "wallet_amounts_owed"."amount_baht")
);
--> statement-breakpoint
CREATE TABLE "wallet_earnings_conversions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_baht" bigint NOT NULL,
	"ledger_transaction_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_earnings_conversions_ledger_transaction_id_unique" UNIQUE("ledger_transaction_id"),
	CONSTRAINT "wallet_earnings_conversions_amount_check" CHECK ("wallet_earnings_conversions"."amount_baht" > 0)
);
--> statement-breakpoint
CREATE TABLE "wallet_idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"principal_user_id" uuid NOT NULL,
	"operation_scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "wallet_idempotency_keys_principal_scope_key" UNIQUE("principal_user_id","operation_scope","key")
);
--> statement-breakpoint
CREATE TABLE "wallet_ledger_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"type" text NOT NULL,
	"currency" text DEFAULT 'THB' NOT NULL,
	"wallet_id" uuid,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_ledger_accounts_code_unique" UNIQUE("code"),
	CONSTRAINT "wallet_ledger_accounts_type_check" CHECK ("wallet_ledger_accounts"."type" IN ('SPENDING', 'EARNINGS', 'HELD_FOR_JOBS', 'RESERVED_FOR_PAYOUTS', 'PLATFORM_REVENUE', 'PLATFORM_SUSPENSE')),
	CONSTRAINT "wallet_ledger_accounts_currency_check" CHECK ("wallet_ledger_accounts"."currency" = 'THB'),
	CONSTRAINT "wallet_ledger_accounts_owner_pair_check" CHECK (("wallet_ledger_accounts"."wallet_id" IS NULL) = ("wallet_ledger_accounts"."user_id" IS NULL)),
	CONSTRAINT "wallet_ledger_accounts_platform_type_check" CHECK (("wallet_ledger_accounts"."wallet_id" IS NULL) = ("wallet_ledger_accounts"."type" IN ('PLATFORM_REVENUE', 'PLATFORM_SUSPENSE')))
);
--> statement-breakpoint
CREATE TABLE "wallet_ledger_postings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"amount_baht" bigint NOT NULL,
	"currency" text DEFAULT 'THB' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_ledger_postings_amount_check" CHECK ("wallet_ledger_postings"."amount_baht" <> 0),
	CONSTRAINT "wallet_ledger_postings_currency_check" CHECK ("wallet_ledger_postings"."currency" = 'THB')
);
--> statement-breakpoint
CREATE TABLE "wallet_ledger_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_reference" text NOT NULL,
	"event_type" text NOT NULL,
	"idempotency_key_id" uuid,
	"correction_of_transaction_id" uuid,
	"created_by_user_id" uuid,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sealed_at" timestamp with time zone,
	CONSTRAINT "wallet_ledger_transactions_business_reference_unique" UNIQUE("business_reference"),
	CONSTRAINT "wallet_ledger_transactions_idempotency_key_id_unique" UNIQUE("idempotency_key_id"),
	CONSTRAINT "wallet_ledger_transactions_event_type_check" CHECK ("wallet_ledger_transactions"."event_type" IN ('TOP_UP', 'PAYOUT', 'ESCROW_HOLD', 'ESCROW_RELEASE', 'ADJUSTMENT', 'EARNINGS_CONVERSION'))
);
--> statement-breakpoint
CREATE TABLE "wallet_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_user_id" uuid,
	"actor_admin_id" uuid,
	"reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_status_history_from_status_check" CHECK ("wallet_status_history"."from_status" IS NULL OR "wallet_status_history"."from_status" IN ('ACTIVE', 'FROZEN', 'SUSPENDED', 'CLOSED')),
	CONSTRAINT "wallet_status_history_to_status_check" CHECK ("wallet_status_history"."to_status" IN ('ACTIVE', 'FROZEN', 'SUSPENDED', 'CLOSED')),
	CONSTRAINT "wallet_status_history_actor_check" CHECK (num_nonnulls("wallet_status_history"."actor_user_id", "wallet_status_history"."actor_admin_id") <= 1)
);
--> statement-breakpoint
CREATE TABLE "wallet_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"spending_balance_baht" bigint DEFAULT 0 NOT NULL,
	"earnings_balance_baht" bigint DEFAULT 0 NOT NULL,
	"held_for_jobs_baht" bigint DEFAULT 0 NOT NULL,
	"reserved_for_payouts_baht" bigint DEFAULT 0 NOT NULL,
	"wallet_status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_wallets_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "wallet_wallets_balance_check" CHECK ("wallet_wallets"."spending_balance_baht" >= 0 AND "wallet_wallets"."earnings_balance_baht" >= 0 AND "wallet_wallets"."held_for_jobs_baht" >= 0 AND "wallet_wallets"."reserved_for_payouts_baht" >= 0),
	CONSTRAINT "wallet_wallets_status_check" CHECK ("wallet_wallets"."wallet_status" IN ('ACTIVE', 'FROZEN', 'SUSPENDED', 'CLOSED'))
);
--> statement-breakpoint
ALTER TABLE "auth_user" DROP CONSTRAINT "auth_user_academic_year_check";--> statement-breakpoint
DROP INDEX "auth_admin_email_uidx";--> statement-breakpoint
ALTER TABLE "department" ALTER COLUMN "name" SET DATA TYPE varchar(100);--> statement-breakpoint
ALTER TABLE "faculty" ALTER COLUMN "name" SET DATA TYPE varchar(100);--> statement-breakpoint
ALTER TABLE "occupation" ALTER COLUMN "name" SET DATA TYPE varchar(100);--> statement-breakpoint
ALTER TABLE "auth_account" ALTER COLUMN "account_id" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "auth_account" ALTER COLUMN "provider_id" SET DATA TYPE varchar(100);--> statement-breakpoint
ALTER TABLE "auth_account" ALTER COLUMN "access_token" SET DATA TYPE varchar(8192);--> statement-breakpoint
ALTER TABLE "auth_account" ALTER COLUMN "refresh_token" SET DATA TYPE varchar(8192);--> statement-breakpoint
ALTER TABLE "auth_account" ALTER COLUMN "id_token" SET DATA TYPE varchar(8192);--> statement-breakpoint
ALTER TABLE "auth_account" ALTER COLUMN "scope" SET DATA TYPE varchar(2048);--> statement-breakpoint
ALTER TABLE "auth_account" ALTER COLUMN "password" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "auth_admin" ALTER COLUMN "username" SET DATA TYPE varchar(100);--> statement-breakpoint
ALTER TABLE "auth_admin" ALTER COLUMN "image" SET DATA TYPE varchar(2048);--> statement-breakpoint
ALTER TABLE "auth_admin" ALTER COLUMN "first_name" SET DATA TYPE varchar(100);--> statement-breakpoint
ALTER TABLE "auth_admin" ALTER COLUMN "last_name" SET DATA TYPE varchar(100);--> statement-breakpoint
ALTER TABLE "auth_session" ALTER COLUMN "token" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "auth_session" ALTER COLUMN "ip_address" SET DATA TYPE inet USING NULLIF("ip_address", '')::inet;--> statement-breakpoint
ALTER TABLE "auth_session" ALTER COLUMN "user_agent" SET DATA TYPE varchar(512);--> statement-breakpoint
ALTER TABLE "auth_user" ALTER COLUMN "image" SET DATA TYPE varchar(2048);--> statement-breakpoint
ALTER TABLE "auth_user" ALTER COLUMN "first_name" SET DATA TYPE varchar(100);--> statement-breakpoint
ALTER TABLE "auth_user" ALTER COLUMN "last_name" SET DATA TYPE varchar(100);--> statement-breakpoint
ALTER TABLE "auth_user" ALTER COLUMN "bio" SET DATA TYPE varchar(1000);--> statement-breakpoint
ALTER TABLE "auth_user" ALTER COLUMN "student_id" SET DATA TYPE varchar(10);--> statement-breakpoint
ALTER TABLE "auth_user" ALTER COLUMN "telephone" SET DATA TYPE varchar(12);--> statement-breakpoint
ALTER TABLE "auth_user" ALTER COLUMN "terms_version" SET DATA TYPE varchar(50);--> statement-breakpoint
ALTER TABLE "auth_verification" ALTER COLUMN "value" SET DATA TYPE varchar(2048);--> statement-breakpoint
ALTER TABLE "file" ALTER COLUMN "bucket" SET DATA TYPE varchar(63);--> statement-breakpoint
ALTER TABLE "file" ALTER COLUMN "object_key" SET DATA TYPE varchar(1024);--> statement-breakpoint
ALTER TABLE "file" ALTER COLUMN "content_type" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "profile_certificate" ALTER COLUMN "name" SET DATA TYPE varchar(200);--> statement-breakpoint
ALTER TABLE "profile_certificate" ALTER COLUMN "issuer" SET DATA TYPE varchar(200);--> statement-breakpoint
ALTER TABLE "profile_portfolio_item" ALTER COLUMN "title" SET DATA TYPE varchar(120);--> statement-breakpoint
ALTER TABLE "profile_portfolio_item" ALTER COLUMN "description" SET DATA TYPE varchar(1000);--> statement-breakpoint
ALTER TABLE "profile_work_experience" ALTER COLUMN "title" SET DATA TYPE varchar(120);--> statement-breakpoint
ALTER TABLE "profile_work_experience" ALTER COLUMN "employment_type" SET DATA TYPE varchar(50);--> statement-breakpoint
ALTER TABLE "profile_work_experience" ALTER COLUMN "org" SET DATA TYPE varchar(200);--> statement-breakpoint
ALTER TABLE "profile_work_experience" ALTER COLUMN "description" SET DATA TYPE varchar(1000);--> statement-breakpoint
ALTER TABLE "auth_user" ADD COLUMN "id_uuid" uuid DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "auth_admin" ADD COLUMN "id_uuid" uuid DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "auth_session" ADD COLUMN "id_uuid" uuid DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "auth_account" ADD COLUMN "id_uuid" uuid DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "auth_verification" ADD COLUMN "id_uuid" uuid DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "auth_session" ADD COLUMN "user_id_uuid" uuid;--> statement-breakpoint
ALTER TABLE "auth_session" ADD COLUMN "admin_id_uuid" uuid;--> statement-breakpoint
ALTER TABLE "auth_account" ADD COLUMN "user_id_uuid" uuid;--> statement-breakpoint
ALTER TABLE "auth_account" ADD COLUMN "admin_id_uuid" uuid;--> statement-breakpoint
ALTER TABLE "file" ADD COLUMN "uploaded_by_user_id_uuid" uuid;--> statement-breakpoint
ALTER TABLE "profile_certificate" ADD COLUMN "user_id_uuid" uuid;--> statement-breakpoint
ALTER TABLE "profile_portfolio_item" ADD COLUMN "user_id_uuid" uuid;--> statement-breakpoint
ALTER TABLE "profile_work_experience" ADD COLUMN "user_id_uuid" uuid;--> statement-breakpoint
UPDATE "auth_session" AS s SET "user_id_uuid" = u."id_uuid" FROM "auth_user" AS u WHERE s."user_id" = u."id";--> statement-breakpoint
UPDATE "auth_session" AS s SET "admin_id_uuid" = a."id_uuid" FROM "auth_admin" AS a WHERE s."admin_id" = a."id";--> statement-breakpoint
UPDATE "auth_account" AS a SET "user_id_uuid" = u."id_uuid" FROM "auth_user" AS u WHERE a."user_id" = u."id";--> statement-breakpoint
UPDATE "auth_account" AS a SET "admin_id_uuid" = ad."id_uuid" FROM "auth_admin" AS ad WHERE a."admin_id" = ad."id";--> statement-breakpoint
UPDATE "file" AS f SET "uploaded_by_user_id_uuid" = u."id_uuid" FROM "auth_user" AS u WHERE f."uploaded_by_user_id" = u."id";--> statement-breakpoint
UPDATE "profile_certificate" AS p SET "user_id_uuid" = u."id_uuid" FROM "auth_user" AS u WHERE p."user_id" = u."id";--> statement-breakpoint
UPDATE "profile_portfolio_item" AS p SET "user_id_uuid" = u."id_uuid" FROM "auth_user" AS u WHERE p."user_id" = u."id";--> statement-breakpoint
UPDATE "profile_work_experience" AS p SET "user_id_uuid" = u."id_uuid" FROM "auth_user" AS u WHERE p."user_id" = u."id";--> statement-breakpoint
ALTER TABLE "auth_account" DROP CONSTRAINT "auth_account_admin_id_auth_admin_id_fk";--> statement-breakpoint
ALTER TABLE "auth_account" DROP CONSTRAINT "auth_account_user_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "auth_session" DROP CONSTRAINT "auth_session_admin_id_auth_admin_id_fk";--> statement-breakpoint
ALTER TABLE "auth_session" DROP CONSTRAINT "auth_session_user_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "file" DROP CONSTRAINT "file_uploaded_by_user_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "profile_certificate" DROP CONSTRAINT "profile_certificate_user_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "profile_portfolio_item" DROP CONSTRAINT "profile_portfolio_item_user_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "profile_work_experience" DROP CONSTRAINT "profile_work_experience_user_id_auth_user_id_fk";--> statement-breakpoint
ALTER TABLE "auth_user" DROP CONSTRAINT "auth_user_pkey";--> statement-breakpoint
ALTER TABLE "auth_admin" DROP CONSTRAINT "auth_admin_pkey";--> statement-breakpoint
ALTER TABLE "auth_session" DROP CONSTRAINT "auth_session_pkey";--> statement-breakpoint
ALTER TABLE "auth_account" DROP CONSTRAINT "auth_account_pkey";--> statement-breakpoint
ALTER TABLE "auth_verification" DROP CONSTRAINT "auth_verification_pkey";--> statement-breakpoint
ALTER TABLE "auth_user" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "auth_user" RENAME COLUMN "id_uuid" TO "id";--> statement-breakpoint
ALTER TABLE "auth_user" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "auth_user" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_user" ADD CONSTRAINT "auth_user_pkey" PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "auth_admin" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "auth_admin" RENAME COLUMN "id_uuid" TO "id";--> statement-breakpoint
ALTER TABLE "auth_admin" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "auth_admin" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_admin" ADD CONSTRAINT "auth_admin_pkey" PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "auth_session" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "auth_session" RENAME COLUMN "id_uuid" TO "id";--> statement-breakpoint
ALTER TABLE "auth_session" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "auth_session" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_pkey" PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "auth_account" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "auth_account" RENAME COLUMN "id_uuid" TO "id";--> statement-breakpoint
ALTER TABLE "auth_account" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "auth_account" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_pkey" PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "auth_verification" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "auth_verification" RENAME COLUMN "id_uuid" TO "id";--> statement-breakpoint
ALTER TABLE "auth_verification" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "auth_verification" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_verification" ADD CONSTRAINT "auth_verification_pkey" PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "auth_session" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "auth_session" RENAME COLUMN "user_id_uuid" TO "user_id";--> statement-breakpoint
ALTER TABLE "auth_session" DROP COLUMN "admin_id";--> statement-breakpoint
ALTER TABLE "auth_session" RENAME COLUMN "admin_id_uuid" TO "admin_id";--> statement-breakpoint
ALTER TABLE "auth_account" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "auth_account" RENAME COLUMN "user_id_uuid" TO "user_id";--> statement-breakpoint
ALTER TABLE "auth_account" DROP COLUMN "admin_id";--> statement-breakpoint
ALTER TABLE "auth_account" RENAME COLUMN "admin_id_uuid" TO "admin_id";--> statement-breakpoint
ALTER TABLE "file" DROP COLUMN "uploaded_by_user_id";--> statement-breakpoint
ALTER TABLE "file" RENAME COLUMN "uploaded_by_user_id_uuid" TO "uploaded_by_user_id";--> statement-breakpoint
ALTER TABLE "profile_certificate" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "profile_certificate" RENAME COLUMN "user_id_uuid" TO "user_id";--> statement-breakpoint
ALTER TABLE "profile_certificate" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "profile_portfolio_item" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "profile_portfolio_item" RENAME COLUMN "user_id_uuid" TO "user_id";--> statement-breakpoint
ALTER TABLE "profile_portfolio_item" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "profile_work_experience" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "profile_work_experience" RENAME COLUMN "user_id_uuid" TO "user_id";--> statement-breakpoint
ALTER TABLE "profile_work_experience" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_user" ALTER COLUMN "email" SET DATA TYPE citext USING "email"::citext;--> statement-breakpoint
ALTER TABLE "auth_admin" ALTER COLUMN "email" SET DATA TYPE citext USING "email"::citext;--> statement-breakpoint
ALTER TABLE "auth_verification" ALTER COLUMN "identifier" SET DATA TYPE citext USING "identifier"::citext;--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_admin_id_auth_admin_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_admin_id_auth_admin_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_uploaded_by_user_id_auth_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_certificate" ADD CONSTRAINT "profile_certificate_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_portfolio_item" ADD CONSTRAINT "profile_portfolio_item_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_work_experience" ADD CONSTRAINT "profile_work_experience_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_money_policy_revisions" ADD CONSTRAINT "payment_money_policy_revisions_authored_by_admin_id_auth_admin_id_fk" FOREIGN KEY ("authored_by_admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "wallet_activities" ADD CONSTRAINT "wallet_activities_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_adjustments" ADD CONSTRAINT "wallet_adjustments_wallet_id_wallet_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallet_wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_adjustments" ADD CONSTRAINT "wallet_adjustments_admin_id_auth_admin_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_adjustments" ADD CONSTRAINT "wallet_adjustments_ledger_transaction_id_wallet_ledger_transactions_id_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."wallet_ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_amounts_owed" ADD CONSTRAINT "wallet_amounts_owed_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_earnings_conversions" ADD CONSTRAINT "wallet_earnings_conversions_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_earnings_conversions" ADD CONSTRAINT "wallet_earnings_conversions_ledger_transaction_id_wallet_ledger_transactions_id_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."wallet_ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_idempotency_keys" ADD CONSTRAINT "wallet_idempotency_keys_principal_user_id_auth_user_id_fk" FOREIGN KEY ("principal_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger_accounts" ADD CONSTRAINT "wallet_ledger_accounts_wallet_id_wallet_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallet_wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger_accounts" ADD CONSTRAINT "wallet_ledger_accounts_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger_postings" ADD CONSTRAINT "wallet_ledger_postings_transaction_id_wallet_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."wallet_ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger_postings" ADD CONSTRAINT "wallet_ledger_postings_account_id_wallet_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."wallet_ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger_transactions" ADD CONSTRAINT "wallet_ledger_transactions_idempotency_key_id_wallet_idempotency_keys_id_fk" FOREIGN KEY ("idempotency_key_id") REFERENCES "public"."wallet_idempotency_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger_transactions" ADD CONSTRAINT "wallet_ledger_transactions_correction_of_transaction_id_wallet_ledger_transactions_id_fk" FOREIGN KEY ("correction_of_transaction_id") REFERENCES "public"."wallet_ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger_transactions" ADD CONSTRAINT "wallet_ledger_transactions_created_by_user_id_auth_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_status_history" ADD CONSTRAINT "wallet_status_history_wallet_id_wallet_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallet_wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_status_history" ADD CONSTRAINT "wallet_status_history_actor_user_id_auth_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_status_history" ADD CONSTRAINT "wallet_status_history_actor_admin_id_auth_admin_id_fk" FOREIGN KEY ("actor_admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_wallets" ADD CONSTRAINT "wallet_wallets_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
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
CREATE INDEX "wallet_activities_user_time_idx" ON "wallet_activities" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "wallet_idempotency_keys_expiry_idx" ON "wallet_idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_ledger_accounts_wallet_type_uidx" ON "wallet_ledger_accounts" USING btree ("wallet_id","type") WHERE "wallet_ledger_accounts"."wallet_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "wallet_ledger_postings_transaction_idx" ON "wallet_ledger_postings" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "wallet_ledger_postings_account_idx" ON "wallet_ledger_postings" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "wallet_status_history_wallet_idx" ON "wallet_status_history" USING btree ("wallet_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_admin_email_uidx" ON "auth_admin" USING btree ("email");--> statement-breakpoint
ALTER TABLE "auth_user" ADD CONSTRAINT "auth_user_academic_year_check" CHECK ("auth_user"."academic_year" IS NULL OR "auth_user"."academic_year" BETWEEN 1000 AND 9999);