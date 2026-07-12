ALTER TABLE "report_sources" ADD COLUMN "notebook_id" uuid;--> statement-breakpoint
ALTER TABLE "notebooks" ADD COLUMN "data_refreshed_at" timestamp with time zone;