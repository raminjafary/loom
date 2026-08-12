CREATE TABLE "plan_subtask" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"planner_run_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"task" text NOT NULL,
	"persona_name" text NOT NULL,
	"paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"agent_run_id" uuid,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plan_subtask" ADD CONSTRAINT "plan_subtask_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_subtask" ADD CONSTRAINT "plan_subtask_planner_run_id_agent_run_id_fk" FOREIGN KEY ("planner_run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_subtask" ADD CONSTRAINT "plan_subtask_agent_run_id_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plan_subtask_position_idx" ON "plan_subtask" USING btree ("planner_run_id","position");--> statement-breakpoint
CREATE INDEX "plan_subtask_planner_idx" ON "plan_subtask" USING btree ("workspace_id","planner_run_id","status");