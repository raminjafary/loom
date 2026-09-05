CREATE TABLE "workflow_design" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"workflow_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"rationale" text NOT NULL,
	"graph" jsonb NOT NULL,
	"digest" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"proposed_by_run_id" uuid,
	"persona_name" text,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_design" ADD CONSTRAINT "workflow_design_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_design" ADD CONSTRAINT "workflow_design_workflow_id_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_design" ADD CONSTRAINT "workflow_design_proposed_by_run_id_agent_run_id_fk" FOREIGN KEY ("proposed_by_run_id") REFERENCES "public"."agent_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_design_workspace_idx" ON "workflow_design" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX "workflow_design_run_idx" ON "workflow_design" USING btree ("proposed_by_run_id");