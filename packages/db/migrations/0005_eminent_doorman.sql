CREATE TABLE "agent_persona" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"markdown_source" text NOT NULL,
	"model" text NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"harness_effort" text,
	"harness_max_turns" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_persona" ADD CONSTRAINT "agent_persona_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_persona_workspace_idx" ON "agent_persona" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_persona_workspace_name_idx" ON "agent_persona" USING btree ("workspace_id","name");