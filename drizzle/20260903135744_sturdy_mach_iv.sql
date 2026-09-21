CREATE TABLE "quest_v2_proof_command" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(200) NOT NULL,
	"quest_id" uuid NOT NULL,
	"principal_user_id" uuid NOT NULL,
	"operation" varchar(64) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"resource_type" varchar(64),
	"resource_id" uuid,
	"result_data" jsonb,
	"processing_status" varchar(32) DEFAULT 'PROCESSING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "quest_v2_proof_command_key_unique" UNIQUE("key"),
	CONSTRAINT "quest_v2_proof_command_key_check" CHECK (btrim("quest_v2_proof_command"."key") <> ''),
	CONSTRAINT "quest_v2_proof_command_operation_check" CHECK (btrim("quest_v2_proof_command"."operation") <> ''),
	CONSTRAINT "quest_v2_proof_command_hash_check" CHECK ("quest_v2_proof_command"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "quest_v2_proof_command_status_check" CHECK ("quest_v2_proof_command"."processing_status" IN ('PROCESSING', 'COMPLETED')),
	CONSTRAINT "quest_v2_proof_command_completion_check" CHECK (("quest_v2_proof_command"."processing_status" = 'COMPLETED') = ("quest_v2_proof_command"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "quest_v2_proof_submission_file" DROP CONSTRAINT "quest_v2_proof_submission_file_proof_submission_id_file_id_pk";--> statement-breakpoint
ALTER TABLE "quest_v2_proof_submission_file" ALTER COLUMN "file_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "quest_v2_proof_submission_file" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "quest_v2_proof_submission_file" ADD COLUMN "upload_status" varchar(32) DEFAULT 'PROOF_FILE_READY' NOT NULL;--> statement-breakpoint
ALTER TABLE "quest_v2_proof_submission_file" ADD COLUMN "failure_code" varchar(64);--> statement-breakpoint
ALTER TABLE "quest_v2_proof_command" ADD CONSTRAINT "quest_v2_proof_command_quest_id_quest_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quest"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_v2_proof_command" ADD CONSTRAINT "quest_v2_proof_command_principal_user_id_auth_user_id_fk" FOREIGN KEY ("principal_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quest_v2_proof_command_quest_idx" ON "quest_v2_proof_command" USING btree ("quest_id");--> statement-breakpoint
CREATE INDEX "quest_v2_proof_command_principal_idx" ON "quest_v2_proof_command" USING btree ("principal_user_id");--> statement-breakpoint
CREATE INDEX "quest_v2_proof_command_expiry_idx" ON "quest_v2_proof_command" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "quest_v2_proof_submission_file" ADD CONSTRAINT "quest_v2_proof_submission_file_status_check" CHECK ("quest_v2_proof_submission_file"."upload_status" IN ('PROOF_FILE_READY', 'PROOF_FILE_FAILED'));--> statement-breakpoint
ALTER TABLE "quest_v2_proof_submission_file" ADD CONSTRAINT "quest_v2_proof_submission_file_ready_check" CHECK (("quest_v2_proof_submission_file"."upload_status" = 'PROOF_FILE_READY') = ("quest_v2_proof_submission_file"."file_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "quest_v2_proof_submission_file" ADD CONSTRAINT "quest_v2_proof_submission_file_failure_check" CHECK (("quest_v2_proof_submission_file"."upload_status" = 'PROOF_FILE_FAILED') = ("quest_v2_proof_submission_file"."failure_code" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "quest_v2_proof_submission_file" ADD CONSTRAINT "quest_v2_proof_submission_file_failure_code_check" CHECK ("quest_v2_proof_submission_file"."failure_code" IS NULL OR btrim("quest_v2_proof_submission_file"."failure_code") <> '');