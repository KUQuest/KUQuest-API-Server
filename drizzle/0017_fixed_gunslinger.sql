CREATE TABLE IF NOT EXISTS "tag" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "tag_name_key" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "tag" ALTER COLUMN "name" SET DATA TYPE varchar(100);
--> statement-breakpoint
-- Keep the fixed Tag vocabulary idempotent across repeated deployments.
INSERT INTO "tag" ("name") VALUES
  ('Frontend'),
  ('Design'),
  ('Data Analysis'),
  ('Content')
ON CONFLICT ("name") DO NOTHING;
