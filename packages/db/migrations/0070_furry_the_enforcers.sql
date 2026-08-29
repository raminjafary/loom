CREATE TABLE "experience_use" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"persona_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"arm" text NOT NULL,
	"lessons_shown" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "experience_trial_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "experience_use" ADD CONSTRAINT "experience_use_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_use" ADD CONSTRAINT "experience_use_persona_id_agent_persona_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."agent_persona"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_use" ADD CONSTRAINT "experience_use_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_use" ADD CONSTRAINT "experience_use_agent_run_id_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "experience_use_run_idx" ON "experience_use" USING btree ("workspace_id","agent_run_id","persona_id","repository_id");--> statement-breakpoint
CREATE INDEX "experience_use_scope_idx" ON "experience_use" USING btree ("workspace_id","persona_id","repository_id","arm");