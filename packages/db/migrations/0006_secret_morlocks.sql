CREATE TABLE "persona_group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"persona_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "persona_group" ADD CONSTRAINT "persona_group_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "persona_group_workspace_idx" ON "persona_group" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "persona_group_workspace_name_idx" ON "persona_group" USING btree ("workspace_id","name");