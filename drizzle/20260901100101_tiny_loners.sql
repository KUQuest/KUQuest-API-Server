CREATE TABLE "admin_action" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_id" uuid NOT NULL,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"request_key" text NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"reason_catalog_version" integer NOT NULL,
	"reason_code" text,
	"expected_version" integer,
	"expected_timestamp" timestamp with time zone,
	"result_version" integer,
	"result_timestamp" timestamp with time zone,
	"metadata" jsonb NOT NULL,
	"result_data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_action_admin_action_request_key" UNIQUE("admin_id","action","request_key"),
	CONSTRAINT "admin_action_action_check" CHECK (btrim("admin_action"."action") <> ''),
	CONSTRAINT "admin_action_resource_type_check" CHECK (btrim("admin_action"."resource_type") <> ''),
	CONSTRAINT "admin_action_resource_id_check" CHECK (btrim("admin_action"."resource_id") <> ''),
	CONSTRAINT "admin_action_request_key_check" CHECK (btrim("admin_action"."request_key") <> ''),
	CONSTRAINT "admin_action_request_hash_check" CHECK ("admin_action"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "admin_action_reason_catalog_version_check" CHECK ("admin_action"."reason_catalog_version" >= 1),
	CONSTRAINT "admin_action_reason_code_check" CHECK ("admin_action"."reason_code" IS NULL OR "admin_action"."reason_code" ~ '^[A-Z][A-Z0-9_.-]{0,99}$'),
	CONSTRAINT "admin_action_resource_version_check" CHECK (("admin_action"."expected_version" IS NULL OR "admin_action"."expected_version" >= 1) AND ("admin_action"."result_version" IS NULL OR "admin_action"."result_version" >= 1)),
	CONSTRAINT "admin_action_resource_revision_check" CHECK (num_nonnulls("admin_action"."expected_version", "admin_action"."expected_timestamp") <= 1 AND num_nonnulls("admin_action"."result_version", "admin_action"."result_timestamp") <= 1),
	CONSTRAINT "admin_action_metadata_object_check" CHECK (jsonb_typeof("admin_action"."metadata") = 'object'),
	CONSTRAINT "admin_action_result_data_object_check" CHECK (jsonb_typeof("admin_action"."result_data") = 'object')
);
--> statement-breakpoint
ALTER TABLE "admin_action" ADD CONSTRAINT "admin_action_admin_id_auth_admin_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."auth_admin"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_action_resource_idx" ON "admin_action" USING btree ("resource_type","resource_id","created_at");--> statement-breakpoint
CREATE INDEX "admin_action_admin_created_idx" ON "admin_action" USING btree ("admin_id","created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION admin_action_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Admin Action is immutable';
END;
$$;--> statement-breakpoint
CREATE TRIGGER admin_action_immutable
BEFORE UPDATE OR DELETE ON admin_action
FOR EACH ROW EXECUTE FUNCTION admin_action_reject_mutation();