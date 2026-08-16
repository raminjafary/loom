CREATE TABLE "persona_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"persona_id" uuid NOT NULL,
	"markdown_source" text NOT NULL,
	"replaced_by_kind" text NOT NULL,
	"replaced_by_run_id" uuid,
	"replaced_by_user_id" text,
	"rationale" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "persona_revision" ADD CONSTRAINT "persona_revision_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_revision" ADD CONSTRAINT "persona_revision_persona_id_agent_persona_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."agent_persona"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_revision" ADD CONSTRAINT "persona_revision_replaced_by_run_id_agent_run_id_fk" FOREIGN KEY ("replaced_by_run_id") REFERENCES "public"."agent_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "persona_revision_persona_idx" ON "persona_revision" USING btree ("workspace_id","persona_id","created_at");