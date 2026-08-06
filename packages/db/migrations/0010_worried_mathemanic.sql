ALTER TABLE "workspace" ADD COLUMN "runs_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "runs_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "runs_paused_by_user_id" text;