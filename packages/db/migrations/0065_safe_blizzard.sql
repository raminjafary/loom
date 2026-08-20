ALTER TABLE "merge_queue_entry" ADD COLUMN "reverted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "merge_queue_entry" ADD COLUMN "reverted_by_sha" text;