ALTER TABLE "metrics" ADD COLUMN "last_run" jsonb;--> statement-breakpoint
ALTER TABLE "metrics" ADD COLUMN "last_run_at" timestamp with time zone;