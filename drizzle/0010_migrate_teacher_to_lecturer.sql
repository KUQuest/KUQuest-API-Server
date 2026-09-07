-- Occupation names are part of the API vocabulary. Preserve existing foreign-key
-- references while replacing the legacy Teacher catalog row with Lecturer.
INSERT INTO "occupation" ("name", "requires_student_id")
VALUES ('Lecturer', false), ('Staff', false), ('Student', true)
ON CONFLICT ("name") DO UPDATE
SET "requires_student_id" = EXCLUDED."requires_student_id";
--> statement-breakpoint
UPDATE "auth_user" AS "student"
SET "occupation_id" = "lecturer"."id"
FROM "occupation" AS "teacher"
JOIN "occupation" AS "lecturer" ON "lecturer"."name" = 'Lecturer'
WHERE "student"."occupation_id" = "teacher"."id"
  AND "teacher"."name" = 'Teacher';
--> statement-breakpoint
DELETE FROM "occupation" WHERE "name" = 'Teacher';
