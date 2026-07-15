CREATE TABLE "accelerate_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"cache_key" text NOT NULL,
	"sql" text NOT NULL,
	"as_of" timestamp with time zone,
	"size_bytes" bigint,
	"status" text NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accelerate_snapshots_connection_cachekey_unique" UNIQUE("connection_id","cache_key")
);
--> statement-breakpoint
ALTER TABLE "accelerate_snapshots" ADD CONSTRAINT "accelerate_snapshots_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;