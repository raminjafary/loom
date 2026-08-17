CREATE TABLE "run_verification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"branch_name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"commit_sha" text,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "repository" ADD COLUMN "verification_checks" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "run_verification" ADD CONSTRAINT "run_verification_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_verification" ADD CONSTRAINT "run_verification_agent_run_id_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_verification" ADD CONSTRAINT "run_verification_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_verification_run_idx" ON "run_verification" USING btree ("agent_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_verification_active_per_repo_idx" ON "run_verification" USING btree ("repository_id") WHERE "run_verification"."status" = 'pending' and "run_verification"."started_at" is not null;--> statement-breakpoint
CREATE INDEX "run_verification_workspace_idx" ON "run_verification" USING btree ("workspace_id","created_at");