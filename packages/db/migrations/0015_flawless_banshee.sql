CREATE TABLE "merge_queue_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position" bigserial NOT NULL,
	"workspace_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"branch_name" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"failure_reason" text,
	"detail" text,
	"merged_commit_sha" text,
	"verified" boolean DEFAULT false NOT NULL,
	"enqueued_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "repository" ADD COLUMN "verify_command" text;--> statement-breakpoint
ALTER TABLE "merge_queue_entry" ADD CONSTRAINT "merge_queue_entry_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_queue_entry" ADD CONSTRAINT "merge_queue_entry_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_queue_entry" ADD CONSTRAINT "merge_queue_entry_agent_run_id_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "merge_queue_repo_idx" ON "merge_queue_entry" USING btree ("workspace_id","repository_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "merge_queue_active_per_repo_idx" ON "merge_queue_entry" USING btree ("repository_id") WHERE "merge_queue_entry"."status" = 'merging';--> statement-breakpoint
CREATE UNIQUE INDEX "merge_queue_open_per_run_idx" ON "merge_queue_entry" USING btree ("agent_run_id") WHERE "merge_queue_entry"."status" in ('queued', 'merging');