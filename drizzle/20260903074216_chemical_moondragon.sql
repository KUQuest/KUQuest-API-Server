CREATE TYPE "public"."chat_conversation_state" AS ENUM('INQUIRY_OPEN', 'INQUIRY_CLOSED');--> statement-breakpoint
ALTER TYPE "public"."chat_membership_role" ADD VALUE 'PROSPECTIVE_WORKER';--> statement-breakpoint
ALTER TABLE "chat_membership" DROP CONSTRAINT "chat_membership_role_assignment_check";--> statement-breakpoint
ALTER TABLE "chat_message_attachment" DROP CONSTRAINT "chat_message_attachment_position_check";--> statement-breakpoint
ALTER TABLE "chat_message" ALTER COLUMN "content_text" SET DATA TYPE varchar(1000);--> statement-breakpoint
ALTER TABLE "chat_conversation" ADD COLUMN "state" "chat_conversation_state";--> statement-breakpoint
ALTER TABLE "chat_conversation" ADD COLUMN "candidate_worker_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_conversation" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_conversation" ADD CONSTRAINT "chat_conversation_candidate_worker_id_auth_user_id_fk" FOREIGN KEY ("candidate_worker_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_conversation_candidate_worker_uidx" ON "chat_conversation" USING btree ("quest_id","candidate_worker_id") WHERE "chat_conversation"."type" = 'CONVERSATION_CANDIDATE_INQUIRY' AND "chat_conversation"."candidate_worker_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "chat_conversation_type_state_idx" ON "chat_conversation" USING btree ("type","state");--> statement-breakpoint
CREATE INDEX "chat_conversation_quest_idx" ON "chat_conversation" USING btree ("quest_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."chat_is_prospective_worker"("public"."chat_membership_role") RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$ SELECT $1::text = 'PROSPECTIVE_WORKER' $$;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_membership_one_active_prospective_worker_uidx" ON "chat_membership" USING btree ("conversation_id") WHERE "public"."chat_is_prospective_worker"("chat_membership"."role") AND "chat_membership"."left_at" IS NULL;--> statement-breakpoint
ALTER TABLE "chat_attachment" ADD CONSTRAINT "chat_attachment_max_size_check" CHECK ("chat_attachment"."size_bytes" <= 10485760);--> statement-breakpoint
ALTER TABLE "chat_attachment" ADD CONSTRAINT "chat_attachment_mime_type_allowed_check" CHECK ("chat_attachment"."mime_type" IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'video/mp4', 'video/webm', 'video/quicktime'));--> statement-breakpoint
ALTER TABLE "chat_conversation" ADD CONSTRAINT "chat_conversation_type_state_check" CHECK (("chat_conversation"."type" = 'CONVERSATION_WORK' AND "chat_conversation"."state" IS NULL AND "chat_conversation"."candidate_worker_id" IS NULL AND "chat_conversation"."closed_at" IS NULL) OR ("chat_conversation"."type" = 'CONVERSATION_CANDIDATE_INQUIRY' AND "chat_conversation"."state" IS NOT NULL AND "chat_conversation"."candidate_worker_id" IS NOT NULL AND (("chat_conversation"."state" = 'INQUIRY_OPEN' AND "chat_conversation"."closed_at" IS NULL) OR ("chat_conversation"."state" = 'INQUIRY_CLOSED' AND "chat_conversation"."closed_at" IS NOT NULL))));--> statement-breakpoint
ALTER TABLE "chat_membership" ADD CONSTRAINT "chat_membership_role_assignment_check" CHECK (("chat_membership"."role"::text IN ('HIRER', 'PROSPECTIVE_WORKER') AND "chat_membership"."assignment_id" IS NULL) OR ("chat_membership"."role"::text = 'WORKER' AND "chat_membership"."assignment_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_content_length_check" CHECK ("chat_message"."content_text" IS NULL OR char_length("chat_message"."content_text") <= 1000);--> statement-breakpoint
ALTER TABLE "chat_message_attachment" ADD CONSTRAINT "chat_message_attachment_position_check" CHECK ("chat_message_attachment"."position" BETWEEN 1 AND 5);--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."chat_validate_message_invariants"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_message_id uuid;
  v_conversation_id uuid;
  v_conversation_type chat_conversation_type;
  v_message_kind chat_message_kind;
  v_content_text varchar(1000);
  v_attachment_count integer;
BEGIN
  IF TG_TABLE_NAME = 'chat_message' THEN
    v_message_id := NEW.id;
  ELSE
    v_message_id := COALESCE(NEW.message_id, OLD.message_id);
  END IF;

  SELECT message.conversation_id, message.kind, message.content_text, conversation.type
  INTO v_conversation_id, v_message_kind, v_content_text, v_conversation_type
  FROM chat_message AS message
  INNER JOIN chat_conversation AS conversation ON conversation.id = message.conversation_id
  WHERE message.id = v_message_id;

  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  SELECT count(*)
  INTO v_attachment_count
  FROM chat_message_attachment
  WHERE chat_message_attachment.message_id = v_message_id;

  IF v_message_kind = 'USER' AND v_content_text IS NULL AND v_attachment_count = 0 THEN
    RAISE EXCEPTION 'A user Message must contain text or an Attachment';
  END IF;

  IF v_conversation_type = 'CONVERSATION_CANDIDATE_INQUIRY' AND v_message_kind = 'SYSTEM' THEN
    RAISE EXCEPTION 'Candidate Inquiry Conversations cannot contain System Messages';
  END IF;

  IF TG_TABLE_NAME = 'chat_message_attachment' AND TG_OP <> 'DELETE' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM chat_attachment AS attachment
      WHERE attachment.id = NEW.attachment_id
        AND attachment.conversation_id = v_conversation_id
        AND attachment.status = 'CONSUMED'
        AND attachment.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'Message Attachment must belong to the Message Conversation and be consumed';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "chat_message_invariants_trigger"
AFTER INSERT OR UPDATE ON "public"."chat_message"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."chat_validate_message_invariants"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "chat_message_attachment_invariants_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "public"."chat_message_attachment"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."chat_validate_message_invariants"();
