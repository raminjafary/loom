CREATE TABLE "worker_note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"workspace_id" uuid NOT NULL,
	"tree_run_id" uuid NOT NULL,
	"agent_run_id" uuid,
	"author_kind" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "worker_note" ADD CONSTRAINT "worker_note_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_note" ADD CONSTRAINT "worker_note_tree_run_id_agent_run_id_fk" FOREIGN KEY ("tree_run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_note" ADD CONSTRAINT "worker_note_agent_run_id_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "worker_note_tree_idx" ON "worker_note" USING btree ("workspace_id","tree_run_id","seq");--> statement-breakpoint
CREATE INDEX "worker_note_run_idx" ON "worker_note" USING btree ("workspace_id","agent_run_id");