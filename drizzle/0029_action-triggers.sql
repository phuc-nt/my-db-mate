CREATE TABLE "action_trigger_fires" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger_id" uuid NOT NULL,
	"status" text NOT NULL,
	"http_status" integer,
	"error" text,
	"finding_snapshot" jsonb,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "action_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"condition" jsonb NOT NULL,
	"webhook_url" text NOT NULL,
	"payload_template" text NOT NULL,
	"rate_limit_per_hour" integer DEFAULT 10 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action_trigger_fires" ADD CONSTRAINT "action_trigger_fires_trigger_id_action_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."action_triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_triggers" ADD CONSTRAINT "action_triggers_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;