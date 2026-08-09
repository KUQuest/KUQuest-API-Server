ALTER TABLE "profile_certificate" DROP COLUMN "verify_url";--> statement-breakpoint
ALTER TABLE "profile_certificate" ADD COLUMN "image_file_id" uuid;--> statement-breakpoint
ALTER TABLE "profile_certificate" ADD CONSTRAINT "profile_certificate_image_file_id_file_id_fk" FOREIGN KEY ("image_file_id") REFERENCES "public"."file"("id") ON DELETE no action ON UPDATE no action;
