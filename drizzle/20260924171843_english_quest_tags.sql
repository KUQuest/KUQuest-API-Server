-- Rename bilingual Quest Tags and preserve existing Quest references.
CREATE TEMP TABLE "quest_tag_english_names" (
  "legacy_name" varchar(100) PRIMARY KEY,
  "english_name" varchar(100) NOT NULL UNIQUE
) ON COMMIT DROP;--> statement-breakpoint
INSERT INTO "quest_tag_english_names" ("legacy_name", "english_name") VALUES
  ('ทำความสะอาด (Cleaning)', 'Cleaning'),
  ('ส่งของ (Delivery)', 'Delivery'),
  ('ซ่อมแซม (Fixing)', 'Fixing'),
  ('สอนหนังสือ (Teaching)', 'Teaching'),
  ('กีฬา (Sport)', 'Sport'),
  ('เกมและสันทนาการ (Game/Activity)', 'Game/Activity'),
  ('งานและการบ้าน (Work/Homework)', 'Work/Homework'),
  ('อาหารและเครื่องดื่ม (Food and Drinks)', 'Food and Drinks'),
  ('สัตว์เลี้ยง (Pet)', 'Pet'),
  ('ออกแบบ (Design)', 'Design'),
  ('ถ่ายภาพ (Photography)', 'Photography'),
  ('อื่นๆ (ETC.)', 'Other');--> statement-breakpoint
UPDATE "quest" AS "quest"
SET "tag_id" = "target"."id"
FROM "tag" AS "legacy"
JOIN "quest_tag_english_names" AS "names"
  ON "legacy"."name" = "names"."legacy_name"
JOIN "tag" AS "target"
  ON "target"."name" = "names"."english_name"
WHERE "quest"."tag_id" = "legacy"."id";--> statement-breakpoint
DELETE FROM "tag" AS "legacy"
USING "quest_tag_english_names" AS "names"
JOIN "tag" AS "target"
  ON "target"."name" = "names"."english_name"
WHERE "legacy"."name" = "names"."legacy_name";--> statement-breakpoint
UPDATE "tag" AS "legacy"
SET "name" = "names"."english_name"
FROM "quest_tag_english_names" AS "names"
WHERE "legacy"."name" = "names"."legacy_name";--> statement-breakpoint
INSERT INTO "tag" ("name")
SELECT "english_name" FROM "quest_tag_english_names"
ON CONFLICT ("name") DO NOTHING;