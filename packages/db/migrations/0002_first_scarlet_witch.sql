CREATE TABLE "agent_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"runner_id" uuid NOT NULL,
	"persona" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"total_cost_usd" double precision,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "approval_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"tool_use_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"input" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"resolved_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "repository" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"runner_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"absolute_path" text NOT NULL,
	"default_branch" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runner" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"pairing_token_hash" text NOT NULL,
	"allowed_roots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"connected" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_runner_id_runner_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runner"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_agent_run_id_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_resolved_by_user_id_user_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository" ADD CONSTRAINT "repository_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository" ADD CONSTRAINT "repository_runner_id_runner_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runner"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner" ADD CONSTRAINT "runner_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_run_thread_idx" ON "agent_run" USING btree ("workspace_id","thread_id");--> statement-breakpoint
CREATE INDEX "approval_request_run_idx" ON "approval_request" USING btree ("agent_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_request_tool_use_idx" ON "approval_request" USING btree ("agent_run_id","tool_use_id");--> statement-breakpoint
CREATE INDEX "repository_workspace_idx" ON "repository" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "runner_workspace_idx" ON "runner" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_pairing_token_hash_idx" ON "runner" USING btree ("pairing_token_hash");