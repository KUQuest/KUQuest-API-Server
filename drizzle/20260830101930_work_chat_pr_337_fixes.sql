CREATE TYPE "public"."chat_conversation_type" AS ENUM('CONVERSATION_CANDIDATE_INQUIRY', 'CONVERSATION_WORK');--> statement-breakpoint
ALTER TABLE "chat_attachment" ADD COLUMN "object_deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_conversation" ADD COLUMN "type" "chat_conversation_type" DEFAULT 'CONVERSATION_WORK' NOT NULL;