ALTER TABLE "column_annotations" ADD COLUMN "provenance" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "column_annotations" ADD COLUMN "confidence" double precision DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "glossary_terms" ADD COLUMN "provenance" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "glossary_terms" ADD COLUMN "confidence" double precision DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "table_annotations" ADD COLUMN "provenance" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "table_annotations" ADD COLUMN "confidence" double precision DEFAULT 1 NOT NULL;