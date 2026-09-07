-- Keep this migration idempotent so deployments can safely apply it to databases
-- that already contain catalog rows.
INSERT INTO "occupation" ("name", "requires_student_id") VALUES
  ('Student', true),
  ('Teacher', false)
ON CONFLICT ("name") DO NOTHING;
