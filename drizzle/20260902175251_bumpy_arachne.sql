CREATE TABLE "quest_v2_underfilled_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_id" uuid NOT NULL,
	"quest_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"reward_satang" integer NOT NULL,
	"decision" varchar(16),
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quest_v2_underfilled_consents_decision_worker_key" UNIQUE("decision_id","worker_id"),
	CONSTRAINT "quest_v2_underfilled_consents_decision_assignment_key" UNIQUE("decision_id","assignment_id"),
	CONSTRAINT "quest_v2_underfilled_consents_reward_check" CHECK ("quest_v2_underfilled_consents"."reward_satang" > 0),
	CONSTRAINT "quest_v2_underfilled_consents_decision_check" CHECK ("quest_v2_underfilled_consents"."decision" IS NULL OR "quest_v2_underfilled_consents"."decision" IN ('ACCEPT', 'DECLINE')),
	CONSTRAINT "quest_v2_underfilled_consents_response_check" CHECK (("quest_v2_underfilled_consents"."decision" IS NULL) = ("quest_v2_underfilled_consents"."responded_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "quest_v2_underfilled_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quest_id" uuid NOT NULL,
	"active_worker_count" integer NOT NULL,
	"worker_reward_pool_satang" integer NOT NULL,
	"state" varchar(40) DEFAULT 'UNDERFILLED_DECISION_PENDING' NOT NULL,
	"decision" varchar(16),
	"decision_expires_at" timestamp with time zone NOT NULL,
	"consent_expires_at" timestamp with time zone,
	"detected_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution_code" varchar(32),
	CONSTRAINT "quest_v2_underfilled_decisions_quest_id_key" UNIQUE("quest_id"),
	CONSTRAINT "quest_v2_underfilled_decisions_state_check" CHECK ("quest_v2_underfilled_decisions"."state" IN ('UNDERFILLED_DECISION_PENDING', 'UNDERFILLED_CONSENT_PENDING', 'UNDERFILLED_COMPLETED', 'UNDERFILLED_CANCELLED')),
	CONSTRAINT "quest_v2_underfilled_decisions_worker_count_check" CHECK ("quest_v2_underfilled_decisions"."active_worker_count" > 0),
	CONSTRAINT "quest_v2_underfilled_decisions_pool_check" CHECK ("quest_v2_underfilled_decisions"."worker_reward_pool_satang" > 0),
	CONSTRAINT "quest_v2_underfilled_decisions_decision_check" CHECK ("quest_v2_underfilled_decisions"."decision" IS NULL OR "quest_v2_underfilled_decisions"."decision" IN ('PROCEED', 'CANCEL')),
	CONSTRAINT "quest_v2_underfilled_decisions_resolution_check" CHECK ("quest_v2_underfilled_decisions"."resolution_code" IS NULL OR "quest_v2_underfilled_decisions"."resolution_code" IN ('HIRER_CANCELLED', 'HIRER_DECISION_TIMEOUT', 'WORKER_DECLINED', 'WORKER_CONSENT_TIMEOUT'))
);
--> statement-breakpoint
ALTER TABLE "quest_v2_underfilled_consents" ADD CONSTRAINT "quest_v2_underfilled_consents_decision_id_quest_v2_underfilled_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."quest_v2_underfilled_decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_v2_underfilled_consents" ADD CONSTRAINT "quest_v2_underfilled_consents_quest_id_quest_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quest"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_v2_underfilled_consents" ADD CONSTRAINT "quest_v2_underfilled_consents_assignment_id_quest_assignment_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."quest_assignment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_v2_underfilled_consents" ADD CONSTRAINT "quest_v2_underfilled_consents_worker_id_auth_user_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_v2_underfilled_decisions" ADD CONSTRAINT "quest_v2_underfilled_decisions_quest_id_quest_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quest"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quest_v2_underfilled_consents_quest_id_idx" ON "quest_v2_underfilled_consents" USING btree ("quest_id");--> statement-breakpoint
CREATE INDEX "quest_v2_underfilled_consents_worker_id_idx" ON "quest_v2_underfilled_consents" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "quest_v2_underfilled_decisions_state_idx" ON "quest_v2_underfilled_decisions" USING btree ("state");--> statement-breakpoint
CREATE INDEX "quest_v2_underfilled_decisions_decision_expires_at_idx" ON "quest_v2_underfilled_decisions" USING btree ("decision_expires_at");--> statement-breakpoint
CREATE INDEX "quest_v2_underfilled_decisions_consent_expires_at_idx" ON "quest_v2_underfilled_decisions" USING btree ("consent_expires_at");