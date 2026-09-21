CREATE EXTENSION IF NOT EXISTS "btree_gist";--> statement-breakpoint
CREATE TYPE "public"."chat_attachment_status" AS ENUM('QUARANTINED', 'VALIDATED', 'REJECTED', 'CONSUMED', 'HIDDEN', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."chat_membership_role" AS ENUM('HIRER', 'WORKER');--> statement-breakpoint
CREATE TYPE "public"."chat_message_kind" AS ENUM('USER', 'SYSTEM');--> statement-breakpoint
CREATE TABLE "chat_attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"uploaded_by_member_id" uuid,
	"file_id" uuid,
	"status" "chat_attachment_status" DEFAULT 'QUARANTINED' NOT NULL,
	"original_filename" varchar(255) NOT NULL,
	"mime_type" varchar(255) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"expires_at" timestamp with time zone,
	"validated_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"rejection_reason" varchar(500),
	"consumed_at" timestamp with time zone,
	"hidden_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_attachment_filename_check" CHECK (btrim("chat_attachment"."original_filename") <> ''),
	CONSTRAINT "chat_attachment_mime_type_check" CHECK (btrim("chat_attachment"."mime_type") <> ''),
	CONSTRAINT "chat_attachment_size_check" CHECK ("chat_attachment"."size_bytes" > 0),
	CONSTRAINT "chat_attachment_initial_file_check" CHECK ("chat_attachment"."status" NOT IN ('QUARANTINED', 'REJECTED') OR "chat_attachment"."file_id" IS NULL),
	CONSTRAINT "chat_attachment_ready_file_check" CHECK ("chat_attachment"."status" NOT IN ('VALIDATED', 'CONSUMED', 'HIDDEN') OR "chat_attachment"."file_id" IS NOT NULL),
	CONSTRAINT "chat_attachment_rejected_fields_check" CHECK (("chat_attachment"."status" = 'REJECTED' AND "chat_attachment"."rejected_at" IS NOT NULL AND "chat_attachment"."rejection_reason" IS NOT NULL AND btrim("chat_attachment"."rejection_reason") <> '') OR ("chat_attachment"."status" <> 'REJECTED' AND "chat_attachment"."rejected_at" IS NULL AND "chat_attachment"."rejection_reason" IS NULL)),
	CONSTRAINT "chat_attachment_consumed_time_check" CHECK ("chat_attachment"."status" <> 'CONSUMED' OR "chat_attachment"."consumed_at" IS NOT NULL),
	CONSTRAINT "chat_attachment_hidden_time_check" CHECK ("chat_attachment"."status" <> 'HIDDEN' OR "chat_attachment"."hidden_at" IS NOT NULL),
	CONSTRAINT "chat_attachment_deleted_time_check" CHECK ("chat_attachment"."deleted_at" IS NULL OR "chat_attachment"."deleted_at" >= "chat_attachment"."created_at")
);
--> statement-breakpoint
CREATE TABLE "chat_conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quest_id" uuid NOT NULL,
	"quest_title" varchar(200) NOT NULL,
	"quest_status" varchar(50) NOT NULL,
	"next_sequence" bigint DEFAULT 1 NOT NULL,
	"read_only_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"latest_terminal_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_conversation_quest_id_key" UNIQUE("quest_id"),
	CONSTRAINT "chat_conversation_title_check" CHECK (btrim("chat_conversation"."quest_title") <> ''),
	CONSTRAINT "chat_conversation_status_snapshot_check" CHECK (btrim("chat_conversation"."quest_status") <> ''),
	CONSTRAINT "chat_conversation_next_sequence_check" CHECK ("chat_conversation"."next_sequence" > 0),
	CONSTRAINT "chat_conversation_terminal_time_check" CHECK ("chat_conversation"."latest_terminal_at" IS NULL OR "chat_conversation"."read_only_at" IS NOT NULL),
	CONSTRAINT "chat_conversation_lifecycle_time_order_check" CHECK (("chat_conversation"."latest_terminal_at" IS NULL OR "chat_conversation"."read_only_at" IS NULL OR "chat_conversation"."latest_terminal_at" <= "chat_conversation"."read_only_at") AND ("chat_conversation"."archived_at" IS NULL OR "chat_conversation"."read_only_at" IS NULL OR "chat_conversation"."archived_at" >= "chat_conversation"."read_only_at"))
);
--> statement-breakpoint
CREATE TABLE "chat_membership" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"assignment_id" uuid,
	"member_id" uuid,
	"role" "chat_membership_role" NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	"left_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_membership_conversation_id_id_key" UNIQUE("conversation_id","id"),
	CONSTRAINT "chat_membership_role_assignment_check" CHECK (("chat_membership"."role" = 'HIRER' AND "chat_membership"."assignment_id" IS NULL) OR ("chat_membership"."role" = 'WORKER' AND "chat_membership"."assignment_id" IS NOT NULL)),
	CONSTRAINT "chat_membership_window_order_check" CHECK ("chat_membership"."left_at" IS NULL OR "chat_membership"."left_at" >= "chat_membership"."joined_at"),
	CONSTRAINT "chat_membership_created_time_check" CHECK ("chat_membership"."created_at" >= "chat_membership"."joined_at")
);
--> statement-breakpoint
CREATE TABLE "chat_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"kind" "chat_message_kind" NOT NULL,
	"sender_membership_id" uuid,
	"client_message_id" varchar(128),
	"content_text" varchar(4000),
	"system_type" varchar(100),
	"system_payload" jsonb,
	"event_id" varchar(255),
	"deleted_at" timestamp with time zone,
	"retention_eligible_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_message_conversation_sequence_key" UNIQUE("conversation_id","sequence"),
	CONSTRAINT "chat_message_sequence_check" CHECK ("chat_message"."sequence" > 0),
	CONSTRAINT "chat_message_content_text_check" CHECK ("chat_message"."content_text" IS NULL OR btrim("chat_message"."content_text") <> ''),
	CONSTRAINT "chat_message_kind_fields_check" CHECK (("chat_message"."kind" = 'USER' AND "chat_message"."sender_membership_id" IS NOT NULL AND "chat_message"."client_message_id" IS NOT NULL AND btrim("chat_message"."client_message_id") <> '' AND "chat_message"."event_id" IS NULL AND "chat_message"."system_type" IS NULL AND "chat_message"."system_payload" IS NULL) OR ("chat_message"."kind" = 'SYSTEM' AND "chat_message"."client_message_id" IS NULL AND "chat_message"."event_id" IS NOT NULL AND btrim("chat_message"."event_id") <> '' AND "chat_message"."system_type" IS NOT NULL AND btrim("chat_message"."system_type") <> '' AND "chat_message"."system_payload" IS NOT NULL AND jsonb_typeof("chat_message"."system_payload") = 'object')),
	CONSTRAINT "chat_message_deleted_time_check" CHECK ("chat_message"."deleted_at" IS NULL OR "chat_message"."deleted_at" >= "chat_message"."created_at"),
	CONSTRAINT "chat_message_retention_time_check" CHECK ("chat_message"."retention_eligible_at" IS NULL OR "chat_message"."retention_eligible_at" >= "chat_message"."created_at")
);
--> statement-breakpoint
CREATE TABLE "chat_message_attachment" (
	"message_id" uuid NOT NULL,
	"attachment_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"attached_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_message_attachment_message_id_attachment_id_pk" PRIMARY KEY("message_id","attachment_id"),
	CONSTRAINT "chat_message_attachment_attachment_once_key" UNIQUE("attachment_id"),
	CONSTRAINT "chat_message_attachment_message_position_key" UNIQUE("message_id","position"),
	CONSTRAINT "chat_message_attachment_position_check" CHECK ("chat_message_attachment"."position" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "chat_read_cursor" (
	"conversation_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"last_read_sequence" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_read_cursor_conversation_id_membership_id_pk" PRIMARY KEY("conversation_id","membership_id"),
	CONSTRAINT "chat_read_cursor_sequence_check" CHECK ("chat_read_cursor"."last_read_sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "chat_transition_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"producer" varchar(64) NOT NULL,
	"command_id" varchar(200) NOT NULL,
	"quest_id" uuid NOT NULL,
	"conversation_id" uuid,
	"transition_type" varchar(64) NOT NULL,
	"request_identity" varchar(64) NOT NULL,
	"processing_status" varchar(32) DEFAULT 'PROCESSING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "chat_transition_commands_producer_type_command_key" UNIQUE("producer","transition_type","command_id"),
	CONSTRAINT "chat_transition_commands_status_check" CHECK ("chat_transition_commands"."processing_status" IN ('PROCESSING', 'COMPLETED')),
	CONSTRAINT "chat_transition_commands_completion_check" CHECK (("chat_transition_commands"."processing_status" = 'COMPLETED') = ("chat_transition_commands"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "chat_attachment" ADD CONSTRAINT "chat_attachment_file_id_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_attachment" ADD CONSTRAINT "chat_attachment_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_attachment" ADD CONSTRAINT "chat_attachment_uploaded_by_membership_fk" FOREIGN KEY ("conversation_id","uploaded_by_member_id") REFERENCES "public"."chat_membership"("conversation_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_conversation" ADD CONSTRAINT "chat_conversation_quest_id_quest_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quest"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_membership" ADD CONSTRAINT "chat_membership_member_id_auth_user_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_membership" ADD CONSTRAINT "chat_membership_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_membership" ADD CONSTRAINT "chat_membership_assignment_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."quest_assignment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_sender_membership_fk" FOREIGN KEY ("conversation_id","sender_membership_id") REFERENCES "public"."chat_membership"("conversation_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_attachment" ADD CONSTRAINT "chat_message_attachment_message_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_message"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_attachment" ADD CONSTRAINT "chat_message_attachment_attachment_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."chat_attachment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_read_cursor" ADD CONSTRAINT "chat_read_cursor_membership_fk" FOREIGN KEY ("conversation_id","membership_id") REFERENCES "public"."chat_membership"("conversation_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_transition_commands" ADD CONSTRAINT "chat_transition_commands_quest_id_quest_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quest"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_transition_commands" ADD CONSTRAINT "chat_transition_commands_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_attachment_conversation_created_idx" ON "chat_attachment" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_attachment_file_idx" ON "chat_attachment" USING btree ("file_id") WHERE "chat_attachment"."file_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "chat_attachment_status_expiry_idx" ON "chat_attachment" USING btree ("status","expires_at") WHERE "chat_attachment"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "chat_attachment_uploader_idx" ON "chat_attachment" USING btree ("uploaded_by_member_id","conversation_id","created_at") WHERE "chat_attachment"."uploaded_by_member_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_membership_assignment_uidx" ON "chat_membership" USING btree ("conversation_id","assignment_id") WHERE "chat_membership"."assignment_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_membership_one_active_hirer_uidx" ON "chat_membership" USING btree ("conversation_id") WHERE "chat_membership"."role" = 'HIRER' AND "chat_membership"."left_at" IS NULL;--> statement-breakpoint
ALTER TABLE "chat_membership" ADD CONSTRAINT "chat_membership_non_overlapping_window_excl" EXCLUDE USING gist ("conversation_id" WITH =, "member_id" WITH =, tstzrange("joined_at", COALESCE("left_at", 'infinity'::timestamptz), '[]') WITH &&) WHERE ("member_id" IS NOT NULL);--> statement-breakpoint
CREATE INDEX "chat_membership_member_conversation_idx" ON "chat_membership" USING btree ("member_id","conversation_id","joined_at") WHERE "chat_membership"."member_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "chat_membership_conversation_window_idx" ON "chat_membership" USING btree ("conversation_id","joined_at","left_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_message_client_message_id_uidx" ON "chat_message" USING btree ("sender_membership_id","client_message_id") WHERE "chat_message"."kind" = 'USER';--> statement-breakpoint
CREATE UNIQUE INDEX "chat_message_event_id_uidx" ON "chat_message" USING btree ("event_id") WHERE "chat_message"."kind" = 'SYSTEM';--> statement-breakpoint
CREATE INDEX "chat_message_conversation_created_idx" ON "chat_message" USING btree ("conversation_id","created_at","sequence");--> statement-breakpoint
CREATE INDEX "chat_message_retention_eligible_idx" ON "chat_message" USING btree ("retention_eligible_at") WHERE "chat_message"."retention_eligible_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "chat_transition_commands_quest_id_idx" ON "chat_transition_commands" USING btree ("quest_id");
