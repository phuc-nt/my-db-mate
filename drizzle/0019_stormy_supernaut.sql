ALTER TABLE "connections" ADD COLUMN "accelerate_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "accelerate_ttl_ms" integer;