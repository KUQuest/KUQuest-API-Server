-- Move Candidate Team submission and selection Quest Commands still inside
-- their 24-hour window from the finance key table into quest_command.
INSERT INTO "quest_command" (
  "quest_id", "principal_user_id", "operation_scope", "key", "request_hash",
  "resource_type", "resource_id", "result_data", "processing_status",
  "created_at", "completed_at", "expires_at"
)
SELECT
  t."quest_id",
  w."principal_user_id",
  w."operation_scope",
  btrim(w."key"),
  w."request_hash",
  w."resource_type",
  CASE
    WHEN w."resource_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN w."resource_id"::uuid
    ELSE NULL
  END,
  CASE
    WHEN w."result_data" ? 'outcome'
      THEN jsonb_build_object('kind', 'rejected', 'rejection', w."result_data" -> 'outcome')
    WHEN w."processing_status" = 'COMPLETED'
      THEN jsonb_build_object('kind', 'success', 'result', w."result_data")
    ELSE w."result_data"
  END,
  w."processing_status",
  w."created_at",
  w."completed_at",
  w."expires_at"
FROM "wallet_idempotency_keys" w
LEFT JOIN "quest_candidate_team_v2" t
  ON w."resource_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND t."id" = w."resource_id"::uuid
WHERE w."operation_scope" IN (
  'quest.v2.candidate-team.submit',
  'quest.v2.candidate-team.select'
)
  AND w."expires_at" > now()
  AND btrim(w."key") <> ''
  AND length(btrim(w."key")) <= 200
  AND w."request_hash" ~ '^[0-9a-f]{64}$'
ON CONFLICT DO NOTHING;
