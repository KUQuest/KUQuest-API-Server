-- Move the Quest v2 create, draft edit, publish, and Quest Image commands that
-- are still inside their 24-hour window out of the finance key table and into
-- quest_command.
INSERT INTO "quest_command" (
  "quest_id", "principal_user_id", "operation_scope", "key", "request_hash",
  "resource_type", "resource_id", "result_data", "processing_status",
  "created_at", "completed_at", "expires_at"
)
SELECT
  CASE WHEN w."operation_scope" = 'quest.v2.create' THEN NULL ELSE q."id" END,
  w."principal_user_id",
  w."operation_scope",
  btrim(w."key"),
  w."request_hash",
  w."resource_type",
  NULLIF(w."resource_id", '')::uuid,
  CASE
    WHEN w."processing_status" = 'PROCESSING' THEN w."result_data"
    WHEN w."result_data" IS NULL THEN NULL
    WHEN w."result_data" ? 'outcome' THEN jsonb_build_object('kind', 'rejected', 'rejection', w."result_data" -> 'outcome')
    ELSE jsonb_build_object('kind', 'success', 'result', w."result_data")
  END,
  w."processing_status",
  w."created_at",
  w."completed_at",
  w."expires_at"
FROM "wallet_idempotency_keys" w
LEFT JOIN "quest" q ON q."id" = NULLIF(w."resource_id", '')::uuid
WHERE w."expires_at" > now()
  AND w."operation_scope" IN (
    'quest.v2.create',
    'quest.v2.edit',
    'quest.v2.publish',
    'quest.v2.image.upload',
    'quest.v2.image.remove'
  )
  AND btrim(w."key") <> ''
  AND length(btrim(w."key")) <= 200
  AND w."request_hash" ~ '^[0-9a-f]{64}$'
ON CONFLICT DO NOTHING;
