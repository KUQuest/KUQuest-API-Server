CREATE TABLE "faculty" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "faculty_name_key" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "major" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"faculty_id" uuid NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "major_faculty_id_name_key" UNIQUE("faculty_id","name")
);
--> statement-breakpoint
CREATE TABLE "auth_account" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"admin_id" text,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_account_provider_id_account_id_key" UNIQUE("provider_id","account_id"),
	CONSTRAINT "auth_account_check" CHECK (num_nonnulls("auth_account"."user_id", "auth_account"."admin_id") = 1),
	CONSTRAINT "auth_account_check1" CHECK ("auth_account"."admin_id" IS NULL OR "auth_account"."provider_id" = 'credential')
);
--> statement-breakpoint
CREATE TABLE "auth_admin" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text,
	"email" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"image_file_id" uuid,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"admin_id" text,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_session_token_key" UNIQUE("token"),
	CONSTRAINT "auth_session_check" CHECK (num_nonnulls("auth_session"."user_id", "auth_session"."admin_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "auth_user" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"image_file_id" uuid,
	"bio" text,
	"student_id" text,
	"telephone" text,
	"major_id" uuid,
	"academic_year" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_user_email_key" UNIQUE("email"),
	CONSTRAINT "auth_user_academic_year_check" CHECK ("auth_user"."academic_year" IS NULL OR ("auth_user"."academic_year" >= 1 AND "auth_user"."academic_year" <= 8))
);
--> statement-breakpoint
CREATE TABLE "auth_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket" text NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"uploaded_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_bucket_object_key_key" UNIQUE("bucket","object_key")
);
--> statement-breakpoint
CREATE TABLE "profile_certificate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"issuer" text NOT NULL,
	"issued_at" date NOT NULL,
	"verify_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_portfolio_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_portfolio_item_image" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portfolio_item_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "profile_portfolio_item_image_portfolio_item_id_position_key" UNIQUE("portfolio_item_id","position")
);
--> statement-breakpoint
CREATE TABLE "profile_work_experience" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"employment_type" text NOT NULL,
	"org" text,
	"description" text,
	"started_at" date NOT NULL,
	"ended_at" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_work_experience_check" CHECK ("profile_work_experience"."ended_at" IS NULL OR "profile_work_experience"."ended_at" >= "profile_work_experience"."started_at")
);
--> statement-breakpoint
DROP TABLE "account" CASCADE;--> statement-breakpoint
DROP TABLE "session" CASCADE;--> statement-breakpoint
DROP TABLE "user" CASCADE;--> statement-breakpoint
DROP TABLE "verification" CASCADE;--> statement-breakpoint
ALTER TABLE "major" ADD CONSTRAINT "major_faculty_id_faculty_id_fk" FOREIGN KEY ("faculty_id") REFERENCES "public"."faculty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_admin_id_auth_admin_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_admin" ADD CONSTRAINT "auth_admin_image_file_id_file_id_fk" FOREIGN KEY ("image_file_id") REFERENCES "public"."file"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_admin_id_auth_admin_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_user" ADD CONSTRAINT "auth_user_image_file_id_file_id_fk" FOREIGN KEY ("image_file_id") REFERENCES "public"."file"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_user" ADD CONSTRAINT "auth_user_major_id_major_id_fk" FOREIGN KEY ("major_id") REFERENCES "public"."major"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_uploaded_by_user_id_auth_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_certificate" ADD CONSTRAINT "profile_certificate_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_portfolio_item" ADD CONSTRAINT "profile_portfolio_item_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_portfolio_item_image" ADD CONSTRAINT "profile_portfolio_item_image_portfolio_item_id_profile_portfolio_item_id_fk" FOREIGN KEY ("portfolio_item_id") REFERENCES "public"."profile_portfolio_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_portfolio_item_image" ADD CONSTRAINT "profile_portfolio_item_image_file_id_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_work_experience" ADD CONSTRAINT "profile_work_experience_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_account_admin_id_idx" ON "auth_account" USING btree ("admin_id");--> statement-breakpoint
CREATE INDEX "auth_account_user_id_idx" ON "auth_account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_admin_email_uidx" ON "auth_admin" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "auth_admin_username_uidx" ON "auth_admin" USING btree (lower("username")) WHERE "auth_admin"."username" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "auth_session_admin_id_idx" ON "auth_session" USING btree ("admin_id");--> statement-breakpoint
CREATE INDEX "auth_session_user_id_idx" ON "auth_session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_user_major_id_idx" ON "auth_user" USING btree ("major_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_user_student_id_uidx" ON "auth_user" USING btree ("student_id") WHERE "auth_user"."student_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "auth_verification_identifier_idx" ON "auth_verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "file_uploaded_by_user_id_idx" ON "file" USING btree ("uploaded_by_user_id");--> statement-breakpoint
CREATE INDEX "profile_certificate_user_idx" ON "profile_certificate" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "profile_portfolio_item_user_idx" ON "profile_portfolio_item" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "profile_portfolio_item_image_item_idx" ON "profile_portfolio_item_image" USING btree ("portfolio_item_id");--> statement-breakpoint
CREATE INDEX "profile_work_experience_user_idx" ON "profile_work_experience" USING btree ("user_id");