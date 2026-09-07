ALTER TABLE "quest_team" DROP CONSTRAINT "quest_team_status_check";--> statement-breakpoint
ALTER TABLE "quest_team_invitation" DROP CONSTRAINT "quest_team_invitation_team_id_invited_by_user_id_quest_team_id_leader_id_fk";
--> statement-breakpoint
ALTER TABLE "quest_team_invitation" ADD CONSTRAINT "quest_team_invitation_team_id_quest_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."quest_team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_team" ADD CONSTRAINT "quest_team_status_check" CHECK ("quest_team"."team_status" IN ('TEAM_FORMING', 'TEAM_SUBMITTED', 'TEAM_SELECTED', 'TEAM_REJECTED', 'TEAM_DISBANDED'));