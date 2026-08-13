CREATE TABLE "expertise_use" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"map_id" uuid NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"arm" text NOT NULL,
	"nodes_shown" integer DEFAULT 0 NOT NULL,
	"edges_shown" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subject_map" ADD COLUMN "retrieval_override" text;--> statement-breakpoint
ALTER TABLE "expertise_use" ADD CONSTRAINT "expertise_use_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expertise_use" ADD CONSTRAINT "expertise_use_map_id_subject_map_id_fk" FOREIGN KEY ("map_id") REFERENCES "public"."subject_map"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expertise_use" ADD CONSTRAINT "expertise_use_agent_run_id_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expertise_use_run_map_idx" ON "expertise_use" USING btree ("workspace_id","agent_run_id","map_id");--> statement-breakpoint
CREATE INDEX "expertise_use_map_idx" ON "expertise_use" USING btree ("workspace_id","map_id","arm");