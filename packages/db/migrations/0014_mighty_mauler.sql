ALTER TABLE "agent_run" ADD COLUMN "parent_run_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "relation" text;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_parent_run_id_agent_run_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_run_parent_idx" ON "agent_run" USING btree ("workspace_id","parent_run_id");