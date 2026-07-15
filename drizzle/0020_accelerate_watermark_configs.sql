CREATE TABLE "accelerate_watermark_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"table_name" text NOT NULL,
	"watermark_col" text NOT NULL,
	"last_watermark" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accelerate_watermark_configs_connection_table_unique" UNIQUE("connection_id","table_name")
);
--> statement-breakpoint
ALTER TABLE "accelerate_watermark_configs" ADD CONSTRAINT "accelerate_watermark_configs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;