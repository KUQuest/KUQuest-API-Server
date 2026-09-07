CREATE TABLE "occupation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"requires_student_id" boolean NOT NULL,
	CONSTRAINT "occupation_name_key" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "major" RENAME TO "department";--> statement-breakpoint
ALTER TABLE "auth_user" RENAME COLUMN "major_id" TO "department_id";--> statement-breakpoint
ALTER TABLE "department" DROP CONSTRAINT "major_faculty_id_name_key";--> statement-breakpoint
ALTER TABLE "department" DROP CONSTRAINT "major_faculty_id_faculty_id_fk";
--> statement-breakpoint
ALTER TABLE "auth_user" DROP CONSTRAINT "auth_user_major_id_major_id_fk";
--> statement-breakpoint
DROP INDEX "auth_user_major_id_idx";--> statement-breakpoint
ALTER TABLE "auth_user" ADD COLUMN "occupation_id" uuid;--> statement-breakpoint
ALTER TABLE "auth_user" ADD COLUMN "terms_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_user" ADD COLUMN "terms_version" text;--> statement-breakpoint
ALTER TABLE "department" ADD CONSTRAINT "department_faculty_id_faculty_id_fk" FOREIGN KEY ("faculty_id") REFERENCES "public"."faculty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_user" ADD CONSTRAINT "auth_user_department_id_department_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."department"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_user" ADD CONSTRAINT "auth_user_occupation_id_occupation_id_fk" FOREIGN KEY ("occupation_id") REFERENCES "public"."occupation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_user_department_id_idx" ON "auth_user" USING btree ("department_id");--> statement-breakpoint
ALTER TABLE "department" ADD CONSTRAINT "department_faculty_id_name_key" UNIQUE("faculty_id","name");