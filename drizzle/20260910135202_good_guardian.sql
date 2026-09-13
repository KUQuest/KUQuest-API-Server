-- Move the Underfilled decision and consent Quest Commands that are still
-- inside their 24-hour window out of the finance key table and into
-- quest_command.
INSERT INTO "quest_command" (
  "quest_id", "principal_user_id", "operation_scope", "key", "request_hash",
  "resource_type", "resource_id", "result_data", "processing_status",
  "created_at", "completed_at", "expires_at"
)
SELECT
  NULL,
  "principal_user_id",
  "operation_scope",
  btrim("key"),
  "request_hash",
  "resource_type",
  "resource_id"::uuid,
  CASE
    WHEN "result_data" ? 'outcome'
      THEN jsonb_build_object('kind', 'rejected', 'rejection', "result_data" -> 'outcome')
    WHEN "processing_status" = 'COMPLETED' AND "result_data" ? 'underfilled'
      THEN jsonb_build_object('kind', 'success', 'result', "result_data" -> 'underfilled')
    WHEN "processing_status" = 'COMPLETED'
      THEN jsonb_build_object('kind', 'success', 'result', "result_data")
    ELSE "result_data"
  END,
  "processing_status",
  "created_at",
  "completed_at",
  "expires_at"
FROM "wallet_idempotency_keys"
WHERE "operation_scope" IN (
  'quest.v2.underfilled.decision',
  'quest.v2.underfilled.consent'
)
  AND "expires_at" > now()
  AND btrim("key") <> ''
  AND length(btrim("key")) <= 200
  AND "request_hash" ~ '^[0-9a-f]{64}$'
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Move the Quest Edit request and response Quest Commands that are still inside
-- their 24-hour window into quest_command.
INSERT INTO "quest_command" (
  "quest_id", "principal_user_id", "operation_scope", "key", "request_hash",
  "resource_type", "resource_id", "result_data", "processing_status",
  "created_at", "completed_at", "expires_at"
)
SELECT
  q."id",
  w."principal_user_id",
  w."operation_scope",
  btrim(w."key"),
  w."request_hash",
  w."resource_type",
  NULLIF(w."resource_id", '')::uuid,
  CASE
    WHEN w."result_data" IS NULL THEN NULL
    WHEN w."processing_status" = 'PROCESSING' THEN w."result_data"
    WHEN w."result_data" ? 'outcome' THEN
      jsonb_build_object('kind', 'rejected', 'rejection', w."result_data" -> 'outcome')
    ELSE
      jsonb_build_object('kind', 'success', 'result', w."result_data" -> 'request')
  END,
  w."processing_status",
  w."created_at",
  w."completed_at",
  w."expires_at"
FROM "wallet_idempotency_keys" w
LEFT JOIN "quest_v2_edit_request" r
  ON w."operation_scope" = 'quest.v2.edit-request.respond'
  AND r."id"::text = w."resource_id"
LEFT JOIN "quest" q
  ON q."id"::text = CASE
    WHEN w."result_data" ? 'request' THEN w."result_data" -> 'request' ->> 'questId'
    WHEN w."operation_scope" = 'quest.v2.edit-request.create' THEN w."resource_id"
    WHEN w."operation_scope" = 'quest.v2.edit-request.respond' THEN r."quest_id"::text
  END
WHERE w."operation_scope" IN (
    'quest.v2.edit-request.create',
    'quest.v2.edit-request.respond'
  )
  AND w."expires_at" > now()
  AND btrim(w."key") <> ''
  AND length(btrim(w."key")) <= 200
  AND w."request_hash" ~ '^[0-9a-f]{64}$'
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Retire the separate rating review command table. Move in-window rows into
-- quest_command before the drop.
INSERT INTO "quest_command" (
  "id", "quest_id", "principal_user_id", "operation_scope", "key", "request_hash",
  "resource_type", "resource_id", "result_data", "processing_status",
  "created_at", "completed_at", "expires_at"
)
SELECT
  "id",
  "quest_id",
  "principal_user_id",
  "operation",
  btrim("key"),
  "request_hash",
  CASE WHEN "resource_id" IS NULL THEN NULL ELSE 'quest-v2-review' END,
  "resource_id",
  CASE
    WHEN "result_data" IS NULL THEN NULL
    WHEN "result_data" ? 'outcome'
      THEN jsonb_build_object('kind', 'rejected', 'rejection', "result_data" -> 'outcome')
    ELSE jsonb_build_object('kind', 'success', 'result', "result_data")
  END,
  "processing_status",
  "created_at",
  "completed_at",
  "expires_at"
FROM "quest_v2_review_command"
WHERE "expires_at" > now()
  AND "operation" IN (
    'quest.v2.rating-review.create',
    'quest.v2.rating-review.update'
  )
  AND btrim("key") <> ''
  AND length(btrim("key")) <= 200
  AND "request_hash" ~ '^[0-9a-f]{64}$'
ON CONFLICT DO NOTHING;--> statement-breakpoint
DROP TABLE "quest_v2_review_command" CASCADE;
