CREATE TABLE "run_prosecution" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"prosecutor_run_id" uuid,
	"status" text DEFAULT 'running' NOT NULL,
	"observations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "run_prosecution" ADD CONSTRAINT "run_prosecution_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_prosecution" ADD CONSTRAINT "run_prosecution_agent_run_id_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_prosecution" ADD CONSTRAINT "run_prosecution_prosecutor_run_id_agent_run_id_fk" FOREIGN KEY ("prosecutor_run_id") REFERENCES "public"."agent_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_prosecution_run_idx" ON "run_prosecution" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "run_prosecution_workspace_idx" ON "run_prosecution" USING btree ("workspace_id","created_at");