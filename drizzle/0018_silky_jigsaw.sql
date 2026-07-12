ALTER TABLE "metrics" ADD COLUMN "target" double precision;--> statement-breakpoint
ALTER TABLE "metrics" ADD COLUMN "dimensions" jsonb;