ALTER TABLE "chat_message" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_message" ADD COLUMN "hidden_by_admin_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_hidden_by_admin_id_auth_admin_id_fk" FOREIGN KEY ("hidden_by_admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_hidden_fields_check" CHECK (("chat_message"."hidden_at" IS NULL) = ("chat_message"."hidden_by_admin_id" IS NULL));