ALTER TABLE "agent_persona" ADD COLUMN "harness_approval_mode" text DEFAULT 'ask' NOT NULL;--> statement-breakpoint
-- The backfill, which drizzle-kit does not generate and which is the whole point of
-- this migration: the boolean's two states were the new column's outer two
--. Without it every persona that
-- ran unattended would silently narrow to `ask` on deploy — not a security problem,
-- but a fleet of stalled runs waiting on approvals nobody expected.
UPDATE "agent_persona"
SET "harness_approval_mode" = CASE WHEN "harness_auto_approve" THEN 'auto' ELSE 'ask' END;
