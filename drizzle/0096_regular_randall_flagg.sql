ALTER TABLE "quest_v2_proof_submission" ADD COLUMN "review_reason" varchar(1000);--> statement-breakpoint
ALTER TABLE "quest_v2_proof_submission" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quest_v2_proof_submission" ADD COLUMN "reviewed_by" varchar(16);
UPDATE "quest_v2_proof_submission" AS proof
SET
  "review_reason" = decision."reason",
  "reviewed_at" = decision."created_at",
  "reviewed_by" = CASE WHEN decision."actor_type" = 'SYSTEM' THEN 'AUTO_APPROVE' ELSE 'HIRER' END
FROM "audit_record" AS decision
WHERE proof."submission_status" IN ('PROOF_APPROVED', 'PROOF_NOT_APPROVED')
  AND decision."action" = 'PROOF_REVIEWED'
  AND decision."resource_type" = 'PROOF_SUBMISSION'
  AND decision."resource_id" = proof."id"::text
  AND decision."new_value"->>'status' = proof."submission_status"
  AND decision."actor_type" IN ('SYSTEM', 'MEMBER');