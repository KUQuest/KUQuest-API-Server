-- Move the Candidate Application Quest Commands that are still inside their
-- 24-hour window out of the finance key table and into quest_command. A row
-- carrying an `outcome` is a recorded rejection; every other completed row is
-- a success. quest_id stays NULL: the finance table never carried one.
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
      THEN jsonb_build_object('kind', 'rejected', 'rejection', "result_data")
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
  'quest.v2.candidate-application.create',
  'quest.v2.candidate-application.withdraw',
  'quest.v2.candidate-application.select'
)
  AND "expires_at" > now()
  AND btrim("key") <> ''
  AND length(btrim("key")) <= 200
  AND "request_hash" ~ '^[0-9a-f]{64}$'
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- The six Candidate Team formation commands. Team submission and Hirer team
-- selection keep the finance key table until they adopt the module.
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
      THEN jsonb_build_object('kind', 'rejected', 'rejection', "result_data")
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
  'quest.v2.candidate-team.create',
  'quest.v2.candidate-team.update',
  'quest.v2.candidate-team.join',
  'quest.v2.candidate-team.leave',
  'quest.v2.candidate-team.remove-member',
  'quest.v2.candidate-team.regenerate-code'
)
  AND "expires_at" > now()
  AND btrim("key") <> ''
  AND length(btrim("key")) <= 200
  AND "request_hash" ~ '^[0-9a-f]{64}$'
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Retire the separate proof command table. Its rows keep their identity and
-- their quest_id; the short operation name becomes the full operation scope.
-- This INSERT must run before the DROP below.
INSERT INTO "quest_command" (
  "id", "quest_id", "principal_user_id", "operation_scope", "key", "request_hash",
  "resource_type", "resource_id", "result_data", "processing_status",
  "created_at", "completed_at", "expires_at"
)
SELECT
  "id",
  "quest_id",
  "principal_user_id",
  CASE "operation"
    WHEN 'create' THEN 'quest.v2.proof.create'
    WHEN 'edit' THEN 'quest.v2.proof.edit'
    WHEN 'delete' THEN 'quest.v2.proof.delete'
    WHEN 'submit' THEN 'quest.v2.proof.submit'
    WHEN 'confirm-completion' THEN 'quest.v2.proof.completion-confirmation'
    WHEN 'review' THEN 'quest.v2.proof.review'
    WHEN 'auto-approval' THEN 'quest.v2.proof.auto-approval'
    WHEN 'cleanup' THEN 'quest.v2.proof.upload-cleanup'
  END,
  btrim("key"),
  "request_hash",
  "resource_type",
  "resource_id",
  CASE
    WHEN "result_data" IS NULL THEN NULL
    WHEN "processing_status" = 'PROCESSING' THEN "result_data"
    WHEN "operation" = 'cleanup' THEN "result_data"
    WHEN "result_data" ? 'outcome'
      THEN jsonb_build_object('kind', 'rejected', 'rejection', "result_data" -> 'outcome')
    ELSE jsonb_build_object('kind', 'success', 'result', "result_data")
  END,
  "processing_status",
  "created_at",
  "completed_at",
  "expires_at"
FROM "quest_v2_proof_command"
WHERE "expires_at" > now()
  AND "operation" IN (
    'create', 'edit', 'delete', 'submit',
    'confirm-completion', 'review', 'auto-approval', 'cleanup'
  )
  AND btrim("key") <> ''
  AND length(btrim("key")) <= 200
  AND "request_hash" ~ '^[0-9a-f]{64}$'
ON CONFLICT DO NOTHING;--> statement-breakpoint
DROP TABLE "quest_v2_proof_command" CASCADE;
