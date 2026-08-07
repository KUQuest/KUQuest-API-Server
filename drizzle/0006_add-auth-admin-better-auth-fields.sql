ALTER TABLE "auth_admin" ADD COLUMN "email_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_admin" ADD COLUMN "image" text;