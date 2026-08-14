ALTER TABLE "quest" RENAME COLUMN "wage_baht" TO "reward_baht";--> statement-breakpoint
ALTER TABLE "quest" DROP CONSTRAINT "quest_wage_check";--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_reward_check" CHECK ("quest"."reward_baht" > 0);--> statement-breakpoint
CREATE TABLE "review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quest_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"reviewee_id" uuid NOT NULL,
	"rating" smallint NOT NULL,
	"comment" varchar(1000) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_rating_check" CHECK ("review"."rating" BETWEEN 1 AND 5),
	CONSTRAINT "review_participants_check" CHECK ("review"."reviewer_id" <> "review"."reviewee_id"),
	CONSTRAINT "review_quest_reviewer_reviewee_key" UNIQUE("quest_id","reviewer_id","reviewee_id")
);
--> statement-breakpoint
CREATE INDEX "review_quest_id_idx" ON "review" USING btree ("quest_id");--> statement-breakpoint
CREATE INDEX "review_reviewee_id_idx" ON "review" USING btree ("reviewee_id");--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_quest_id_quest_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quest"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_reviewer_id_auth_user_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_reviewee_id_auth_user_id_fk" FOREIGN KEY ("reviewee_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;
