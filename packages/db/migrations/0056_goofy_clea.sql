CREATE TABLE "prompt_trial_use" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"persona_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"arm" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "persona_revision" ADD COLUMN "trial_decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "prompt_trial_use" ADD CONSTRAINT "prompt_trial_use_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_trial_use" ADD CONSTRAINT "prompt_trial_use_persona_id_agent_persona_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."agent_persona"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_trial_use" ADD CONSTRAINT "prompt_trial_use_revision_id_persona_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."persona_revision"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_trial_use" ADD CONSTRAINT "prompt_trial_use_agent_run_id_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_trial_run_idx" ON "prompt_trial_use" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "prompt_trial_revision_idx" ON "prompt_trial_use" USING btree ("workspace_id","revision_id");