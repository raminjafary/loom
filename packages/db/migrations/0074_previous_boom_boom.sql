DROP INDEX "workflow_step_run_node_idx";--> statement-breakpoint
ALTER TABLE "workflow_step_run" ADD COLUMN "attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_step_run_node_idx" ON "workflow_step_run" USING btree ("workflow_run_id","node_id","pass","item_index","attempt");