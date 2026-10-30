CREATE TABLE "push_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_member_id" uuid NOT NULL,
	"event_key" varchar(200) NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"title" varchar(120) NOT NULL,
	"body" varchar(500) NOT NULL,
	"deep_link" varchar(500) NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(32) DEFAULT 'PUSH_DELIVERY_PENDING' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"last_error_code" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_deliveries_event_key_check" CHECK (btrim("push_deliveries"."event_key") <> ''),
	CONSTRAINT "push_deliveries_event_type_check" CHECK (btrim("push_deliveries"."event_type") <> ''),
	CONSTRAINT "push_deliveries_status_check" CHECK ("push_deliveries"."status" IN ('PUSH_DELIVERY_PENDING', 'PUSH_DELIVERY_DELIVERED', 'PUSH_DELIVERY_FAILED', 'PUSH_DELIVERY_DISABLED')),
	CONSTRAINT "push_deliveries_attempt_count_check" CHECK ("push_deliveries"."attempt_count" >= 0),
	CONSTRAINT "push_deliveries_data_object_check" CHECK (jsonb_typeof("push_deliveries"."data") = 'object')
);
--> statement-breakpoint
CREATE TABLE "push_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"key_version" varchar(32) NOT NULL,
	"nonce" varchar(32) NOT NULL,
	"ciphertext" text NOT NULL,
	"auth_tag" varchar(32) NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_devices_token_hash_check" CHECK ("push_devices"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "push_devices_key_version_check" CHECK (btrim("push_devices"."key_version") <> '')
);
--> statement-breakpoint
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_recipient_member_id_auth_user_id_fk" FOREIGN KEY ("recipient_member_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_member_id_auth_user_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "push_deliveries_recipient_event_uidx" ON "push_deliveries" USING btree ("recipient_member_id","event_key");--> statement-breakpoint
CREATE INDEX "push_deliveries_pending_idx" ON "push_deliveries" USING btree ("status","next_attempt_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "push_devices_token_hash_uidx" ON "push_devices" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "push_devices_member_active_idx" ON "push_devices" USING btree ("member_id","disabled_at");