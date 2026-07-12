ALTER TABLE "scheduled_queries" ADD COLUMN "target_id" uuid;--> statement-breakpoint
ALTER TABLE "scheduled_queries" ADD COLUMN "config" jsonb;