-- Move the Assignment Join Quest Commands that are still inside their
-- 24-hour window out of the finance key table and into the Quest-owned
-- quest_command table, so a retry sent across the deploy still replays.
-- quest_id stays NULL: the finance table never carried one.
INSERT INTO "quest_command" (
  "quest_id", "principal_user_id", "operation_scope", "key", "request_hash",
  "resource_type", "resource_id", "result_data", "processing_status",
  "created_at", "completed_at", "expires_at"
)
SELECT
  NULL,
  w."principal_user_id",
  w."operation_scope",
  btrim(w."key"),
  w."request_hash",
  w."resource_type",
  w."resource_id"::uuid,
  CASE
    WHEN w."processing_status" = 'COMPLETED'
      THEN jsonb_build_object('kind', 'success', 'result', w."result_data")
    ELSE NULL
  END,
  w."processing_status",
  w."created_at",
  w."completed_at",
  w."expires_at"
FROM "wallet_idempotency_keys" w
WHERE w."operation_scope" = 'quest.v2.assignment.join'
  AND w."expires_at" > now()
  AND btrim(w."key") <> ''
  AND length(btrim(w."key")) <= 200
  AND w."request_hash" ~ '^[0-9a-f]{64}$'
ON CONFLICT DO NOTHING;
