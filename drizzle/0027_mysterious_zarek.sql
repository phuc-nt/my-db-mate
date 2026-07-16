CREATE TABLE "anomaly_baselines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"table_name" text NOT NULL,
	"column_name" text NOT NULL,
	"avg" double precision,
	"stddev" double precision,
	"null_rate" double precision NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "anomaly_baselines" ADD CONSTRAINT "anomaly_baselines_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "anomaly_baselines_conn_table_col" ON "anomaly_baselines" USING btree ("connection_id","table_name","column_name");