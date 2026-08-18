CREATE TABLE "virtual_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"sql" text NOT NULL,
	"columns_cache" jsonb,
	"is_disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "virtual_views_connection_name_unique" UNIQUE("connection_id","name")
);
--> statement-breakpoint
ALTER TABLE "virtual_views" ADD CONSTRAINT "virtual_views_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;