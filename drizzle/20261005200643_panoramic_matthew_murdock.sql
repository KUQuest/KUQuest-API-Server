CREATE TABLE "quest_v2_team_reward_allocation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quest_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"leader_id" uuid NOT NULL,
	"status" varchar(24) DEFAULT 'PENDING' NOT NULL,
	"total_reward_satang" integer NOT NULL,
	"total_platform_fee_satang" integer NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quest_v2_team_reward_allocation_quest_id_key" UNIQUE("quest_id"),
	CONSTRAINT "quest_v2_team_reward_allocation_status_check" CHECK ("quest_v2_team_reward_allocation"."status" IN ('PENDING', 'SUBMITTED', 'AUTO_EQUAL')),
	CONSTRAINT "quest_v2_team_reward_allocation_amount_check" CHECK ("quest_v2_team_reward_allocation"."total_reward_satang" > 0 AND "quest_v2_team_reward_allocation"."total_platform_fee_satang" >= 0),
	CONSTRAINT "quest_v2_team_reward_allocation_completion_check" CHECK (("quest_v2_team_reward_allocation"."status" = 'PENDING' AND "quest_v2_team_reward_allocation"."submitted_at" IS NULL AND "quest_v2_team_reward_allocation"."settled_at" IS NULL) OR ("quest_v2_team_reward_allocation"."status" <> 'PENDING' AND "quest_v2_team_reward_allocation"."submitted_at" IS NOT NULL AND "quest_v2_team_reward_allocation"."settled_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "quest_v2_team_reward_allocation_member" (
	"allocation_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"percentage_basis_points" smallint NOT NULL,
	"reward_satang" integer NOT NULL,
	"platform_fee_satang" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quest_v2_team_reward_allocation_member_allocation_id_member_id_pk" PRIMARY KEY("allocation_id","member_id"),
	CONSTRAINT "quest_v2_team_reward_allocation_member_basis_points_check" CHECK ("quest_v2_team_reward_allocation_member"."percentage_basis_points" BETWEEN 0 AND 10000),
	CONSTRAINT "quest_v2_team_reward_allocation_member_amount_check" CHECK ("quest_v2_team_reward_allocation_member"."reward_satang" >= 0 AND "quest_v2_team_reward_allocation_member"."platform_fee_satang" >= 0)
);
--> statement-breakpoint
ALTER TABLE "quest_v2_team_reward_allocation" ADD CONSTRAINT "quest_v2_team_reward_allocation_quest_id_quest_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quest"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_v2_team_reward_allocation" ADD CONSTRAINT "quest_v2_team_reward_allocation_team_id_quest_candidate_team_v2_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."quest_candidate_team_v2"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_v2_team_reward_allocation" ADD CONSTRAINT "quest_v2_team_reward_allocation_leader_id_auth_user_id_fk" FOREIGN KEY ("leader_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_v2_team_reward_allocation_member" ADD CONSTRAINT "quest_v2_team_reward_allocation_member_allocation_id_quest_v2_team_reward_allocation_id_fk" FOREIGN KEY ("allocation_id") REFERENCES "public"."quest_v2_team_reward_allocation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_v2_team_reward_allocation_member" ADD CONSTRAINT "quest_v2_team_reward_allocation_member_member_id_auth_user_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quest_v2_team_reward_allocation_due_idx" ON "quest_v2_team_reward_allocation" USING btree ("status","deadline_at");