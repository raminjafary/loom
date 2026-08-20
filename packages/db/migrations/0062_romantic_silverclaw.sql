CREATE TABLE "persona_proposer_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"persona_id" uuid NOT NULL,
	"agent_run_id" uuid,
	"losing_arms_shown" integer DEFAULT 0 NOT NULL,
	"losing_arms_withheld" integer DEFAULT 0 NOT NULL,
	"refusals_shown" integer DEFAULT 0 NOT NULL,
	"refusals_withheld" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "persona_proposer_session" ADD CONSTRAINT "persona_proposer_session_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_proposer_session" ADD CONSTRAINT "persona_proposer_session_persona_id_agent_persona_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."agent_persona"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_proposer_session" ADD CONSTRAINT "persona_proposer_session_agent_run_id_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "persona_proposer_session_run_idx" ON "persona_proposer_session" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "persona_proposer_session_persona_idx" ON "persona_proposer_session" USING btree ("workspace_id","persona_id","created_at");