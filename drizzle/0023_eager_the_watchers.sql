ALTER TABLE "connections" ADD COLUMN "bigquery_daily_bytes_budget" bigint DEFAULT 10737418240 NOT NULL;--> statement-breakpoint
ALTER TABLE "query_runs" ADD COLUMN "bytes_billed" bigint;