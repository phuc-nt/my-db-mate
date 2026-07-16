CREATE TABLE "bq_budget_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"utc_day" text NOT NULL,
	"reserved_bytes" bigint DEFAULT 0 NOT NULL,
	"committed_bytes" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bq_budget_ledger_conn_day" UNIQUE("connection_id","utc_day")
);
--> statement-breakpoint
ALTER TABLE "bq_budget_ledger" ADD CONSTRAINT "bq_budget_ledger_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;