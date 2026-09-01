LOCK TABLE "quest" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
DO $$
DECLARE
  invalid_count integer;
BEGIN
  SELECT count(*) INTO invalid_count
  FROM "quest"
  WHERE "api_version" = 'v2'
    AND (
      "v2_participation" IS NULL
      OR ("v2_participation" = 'SINGLE' AND "headcount" <> 1)
      OR ("v2_participation" = 'GROUP' AND "headcount" NOT BETWEEN 2 AND 20)
    );

  IF invalid_count > 0 THEN
    RAISE EXCEPTION
      'Cannot enforce the v2 Quest headcount rule: % existing row(s) need manual repair',
      invalid_count;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "quest" DROP CONSTRAINT "quest_participation_headcount_check";--> statement-breakpoint
ALTER TABLE "quest" ADD CONSTRAINT "quest_participation_headcount_check" CHECK ((
        "quest"."api_version" <> 'v2' AND
        ("quest"."participation" = 'GROUP' OR "quest"."headcount" = 1)
      ) OR (
        "quest"."api_version" = 'v2' AND
        "quest"."v2_participation" IS NOT NULL AND
        (
          ("quest"."v2_participation" = 'SINGLE' AND "quest"."headcount" = 1) OR
          ("quest"."v2_participation" = 'GROUP' AND "quest"."headcount" BETWEEN 2 AND 20)
        )
      ));
