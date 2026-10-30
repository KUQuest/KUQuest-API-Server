ALTER TABLE "admin_dispute_cases" DROP CONSTRAINT "admin_dispute_cases_terminal_fields_check";--> statement-breakpoint
ALTER TABLE "admin_dispute_cases" ADD CONSTRAINT "admin_dispute_cases_terminal_fields_check" CHECK ((
        ("admin_dispute_cases"."status" = 'DISPUTE_CASE_PENDING' AND num_nonnulls("admin_dispute_cases"."resolved_worker_id", "admin_dispute_cases"."resolved_amount_satang", "admin_dispute_cases"."resolved_by_admin_id", "admin_dispute_cases"."resolved_at") = 0)
        OR ("admin_dispute_cases"."status" = 'DISPUTE_CASE_DISMISSED' AND num_nonnulls("admin_dispute_cases"."resolved_worker_id", "admin_dispute_cases"."resolved_amount_satang") = 0 AND "admin_dispute_cases"."resolved_at" IS NOT NULL)
        OR ("admin_dispute_cases"."status" = 'DISPUTE_CASE_RESOLVED' AND num_nonnulls("admin_dispute_cases"."resolved_worker_id", "admin_dispute_cases"."resolved_amount_satang", "admin_dispute_cases"."resolved_by_admin_id", "admin_dispute_cases"."resolved_at") = 4)
      ));