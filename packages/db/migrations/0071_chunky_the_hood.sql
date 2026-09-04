CREATE TABLE "workflow" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflow_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"workflow_version_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"input" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"cap_usd" double precision,
	"started_by_user_id" text,
	"halt_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflow_step_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"workflow_run_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"pass" integer DEFAULT 0 NOT NULL,
	"item_index" integer DEFAULT 0 NOT NULL,
	"item" text,
	"claimed_at" timestamp with time zone,
	"agent_run_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"answer" jsonb,
	"reason" text,
	"cost_usd" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflow_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"graph" jsonb NOT NULL,
	"digest" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow" ADD CONSTRAINT "workflow_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_workflow_version_id_workflow_version_id_fk" FOREIGN KEY ("workflow_version_id") REFERENCES "public"."workflow_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_step_run" ADD CONSTRAINT "workflow_step_run_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_step_run" ADD CONSTRAINT "workflow_step_run_workflow_run_id_workflow_run_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_step_run" ADD CONSTRAINT "workflow_step_run_agent_run_id_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_version" ADD CONSTRAINT "workflow_version_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_version" ADD CONSTRAINT "workflow_version_workflow_id_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_name_idx" ON "workflow" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "workflow_run_workspace_idx" ON "workflow_run" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_step_run_node_idx" ON "workflow_step_run" USING btree ("workflow_run_id","node_id","pass","item_index");--> statement-breakpoint
CREATE INDEX "workflow_step_run_status_idx" ON "workflow_step_run" USING btree ("workflow_run_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_version_number_idx" ON "workflow_version" USING btree ("workflow_id","version");--> statement-breakpoint
CREATE INDEX "workflow_version_digest_idx" ON "workflow_version" USING btree ("workspace_id","digest");