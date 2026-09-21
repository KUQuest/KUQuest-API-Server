ALTER TABLE "chat_message_attachment" DROP CONSTRAINT "chat_message_attachment_position_check";--> statement-breakpoint
ALTER TABLE "chat_message_attachment" ALTER COLUMN "position" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "chat_message_attachment" ADD CONSTRAINT "chat_message_attachment_position_check" CHECK ("chat_message_attachment"."position" > 0);