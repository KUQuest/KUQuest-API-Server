ALTER TABLE "quest_assignment" ADD CONSTRAINT "quest_assignment_quest_id_id_key" UNIQUE("quest_id","id");
--> statement-breakpoint
ALTER TABLE "admin_conduct_reports" DROP CONSTRAINT "admin_conduct_reports_assignment_id_quest_assignment_id_fk";
--> statement-breakpoint
ALTER TABLE "admin_conduct_reports" ADD CONSTRAINT "admin_conduct_reports_assignment_context_fk" FOREIGN KEY ("quest_id","assignment_id") REFERENCES "public"."quest_assignment"("quest_id","id") ON DELETE restrict ON UPDATE no action;
