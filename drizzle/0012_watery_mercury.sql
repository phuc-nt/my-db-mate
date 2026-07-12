CREATE TABLE "query_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"question" text NOT NULL,
	"sql_wrong" text NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"session_id" uuid,
	"fixed_verified_query_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "query_feedback" ADD CONSTRAINT "query_feedback_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;