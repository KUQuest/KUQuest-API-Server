CREATE TABLE "admin_dispute_team_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dispute_case_id" uuid NOT NULL,
	"quest_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"leader_id" uuid NOT NULL,
	"status" text DEFAULT 'AWAITING_SPLIT' NOT NULL,
	"split_source" text,
	"approved_amount_satang" integer NOT NULL,
	"split_deadline_at" timestamp with time zone NOT NULL,
	"split_confirmed_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"payment_failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_dispute_team_allocations_case_key" UNIQUE("dispute_case_id"),
	CONSTRAINT "admin_dispute_team_allocations_status_check" CHECK ("admin_dispute_team_allocations"."status" IN ('AWAITING_SPLIT', 'SPLIT_CONFIRMED', 'PAID')),
	CONSTRAINT "admin_dispute_team_allocations_source_check" CHECK ("admin_dispute_team_allocations"."split_source" IS NULL OR "admin_dispute_team_allocations"."split_source" IN ('LEADER', 'AUTO_EQUAL')),
	CONSTRAINT "admin_dispute_team_allocations_amount_check" CHECK ("admin_dispute_team_allocations"."approved_amount_satang" BETWEEN 1 AND 2000000000),
	CONSTRAINT "admin_dispute_team_allocations_progress_check" CHECK ((
        ("admin_dispute_team_allocations"."status" = 'AWAITING_SPLIT' AND "admin_dispute_team_allocations"."split_source" IS NULL AND "admin_dispute_team_allocations"."split_confirmed_at" IS NULL AND "admin_dispute_team_allocations"."paid_at" IS NULL)
        OR ("admin_dispute_team_allocations"."status" = 'SPLIT_CONFIRMED' AND "admin_dispute_team_allocations"."split_source" IS NOT NULL AND "admin_dispute_team_allocations"."split_confirmed_at" IS NOT NULL AND "admin_dispute_team_allocations"."paid_at" IS NULL)
        OR ("admin_dispute_team_allocations"."status" = 'PAID' AND "admin_dispute_team_allocations"."split_source" IS NOT NULL AND "admin_dispute_team_allocations"."split_confirmed_at" IS NOT NULL AND "admin_dispute_team_allocations"."paid_at" IS NOT NULL AND "admin_dispute_team_allocations"."payment_failure_code" IS NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "admin_dispute_team_allocation_members" (
	"allocation_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"percentage_basis_points" integer NOT NULL,
	"amount_satang" integer NOT NULL,
	"ledger_transaction_id" uuid,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_dispute_team_allocation_members_key" UNIQUE("allocation_id","member_id"),
	CONSTRAINT "admin_dispute_team_allocation_members_basis_points_check" CHECK ("admin_dispute_team_allocation_members"."percentage_basis_points" BETWEEN 0 AND 10000),
	CONSTRAINT "admin_dispute_team_allocation_members_amount_check" CHECK ("admin_dispute_team_allocation_members"."amount_satang" BETWEEN 0 AND 2000000000),
	CONSTRAINT "admin_dispute_team_allocation_members_paid_check" CHECK (("admin_dispute_team_allocation_members"."ledger_transaction_id" IS NULL) = ("admin_dispute_team_allocation_members"."paid_at" IS NULL OR "admin_dispute_team_allocation_members"."amount_satang" = 0))
);
--> statement-breakpoint
ALTER TABLE "admin_dispute_cases" ADD COLUMN "team_id" uuid;--> statement-breakpoint
ALTER TABLE "admin_dispute_team_allocations" ADD CONSTRAINT "admin_dispute_team_allocations_dispute_case_id_admin_dispute_cases_id_fk" FOREIGN KEY ("dispute_case_id") REFERENCES "public"."admin_dispute_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_dispute_team_allocations" ADD CONSTRAINT "admin_dispute_team_allocations_quest_id_quest_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quest"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_dispute_team_allocations" ADD CONSTRAINT "admin_dispute_team_allocations_team_id_quest_candidate_team_v2_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."quest_candidate_team_v2"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_dispute_team_allocations" ADD CONSTRAINT "admin_dispute_team_allocations_leader_id_auth_user_id_fk" FOREIGN KEY ("leader_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_dispute_team_allocation_members" ADD CONSTRAINT "admin_dispute_team_allocation_members_allocation_id_admin_dispute_team_allocations_id_fk" FOREIGN KEY ("allocation_id") REFERENCES "public"."admin_dispute_team_allocations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_dispute_team_allocation_members" ADD CONSTRAINT "admin_dispute_team_allocation_members_member_id_auth_user_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_dispute_team_allocation_members" ADD CONSTRAINT "admin_dispute_team_allocation_members_ledger_transaction_id_wallet_ledger_transactions_id_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."wallet_ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_dispute_team_allocations_quest_idx" ON "admin_dispute_team_allocations" USING btree ("quest_id");--> statement-breakpoint
CREATE INDEX "admin_dispute_team_allocations_due_idx" ON "admin_dispute_team_allocations" USING btree ("status","split_deadline_at");--> statement-breakpoint
ALTER TABLE "admin_dispute_cases" ADD CONSTRAINT "admin_dispute_cases_team_id_quest_candidate_team_v2_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."quest_candidate_team_v2"("id") ON DELETE no action ON UPDATE no action;