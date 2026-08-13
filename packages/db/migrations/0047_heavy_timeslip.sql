CREATE TABLE "atlas_edge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"from_node_id" uuid NOT NULL,
	"to_node_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"rationale" text NOT NULL,
	"proposed_by_persona_id" uuid,
	"proposed_by_run_id" uuid,
	"status" text DEFAULT 'proposed' NOT NULL,
	"session_id" uuid,
	"decided_by_user_id" text,
	"decided_by_name" text DEFAULT '' NOT NULL,
	"decided_at" timestamp with time zone,
	"decision_note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "atlas_edge" ADD CONSTRAINT "atlas_edge_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atlas_edge" ADD CONSTRAINT "atlas_edge_from_node_id_subject_map_node_id_fk" FOREIGN KEY ("from_node_id") REFERENCES "public"."subject_map_node"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atlas_edge" ADD CONSTRAINT "atlas_edge_to_node_id_subject_map_node_id_fk" FOREIGN KEY ("to_node_id") REFERENCES "public"."subject_map_node"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atlas_edge" ADD CONSTRAINT "atlas_edge_proposed_by_persona_id_agent_persona_id_fk" FOREIGN KEY ("proposed_by_persona_id") REFERENCES "public"."agent_persona"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atlas_edge" ADD CONSTRAINT "atlas_edge_proposed_by_run_id_agent_run_id_fk" FOREIGN KEY ("proposed_by_run_id") REFERENCES "public"."agent_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atlas_edge" ADD CONSTRAINT "atlas_edge_session_id_colosseum_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."colosseum_session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atlas_edge" ADD CONSTRAINT "atlas_edge_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "atlas_edge_pair_idx" ON "atlas_edge" USING btree ("workspace_id","from_node_id","to_node_id","relation");--> statement-breakpoint
CREATE INDEX "atlas_edge_status_idx" ON "atlas_edge" USING btree ("workspace_id","status");