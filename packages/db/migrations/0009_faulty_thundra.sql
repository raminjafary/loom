ALTER TABLE "agent_run" ADD COLUMN "last_heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "last_event_at" timestamp with time zone;