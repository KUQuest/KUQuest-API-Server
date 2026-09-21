ALTER TABLE "review" ALTER COLUMN "comment" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_comment_check" CHECK ("review"."comment" IS NULL OR btrim("review"."comment") <> '');
