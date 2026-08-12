CREATE TABLE "mastery_checkpoint" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"workspace_id" uuid NOT NULL,
	"map_id" uuid NOT NULL,
	"agent_run_id" uuid,
	"files_read" integer DEFAULT 0 NOT NULL,
	"files_in_scope" integer DEFAULT 0 NOT NULL,
	"node_count" integer DEFAULT 0 NOT NULL,
	"edge_count" integer DEFAULT 0 NOT NULL,
	"spend_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subject_map" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"persona_id" uuid NOT NULL,
	"subject_kind" text NOT NULL,
	"repository_id" uuid,
	"subject_ref" text NOT NULL,
	"revision" text NOT NULL,
	"status" text DEFAULT 'mastering' NOT NULL,
	"mastery_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subject_map_edge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"map_id" uuid NOT NULL,
	"from_key" text NOT NULL,
	"to_key" text NOT NULL,
	"kind" text NOT NULL,
	"provenance" text NOT NULL,
	"derived_at_revision" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp with time zone,
	"invalidated_reason" text
);
--> statement-breakpoint
CREATE TABLE "subject_map_node" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"map_id" uuid NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"provenance" text NOT NULL,
	"paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"observation_count" integer DEFAULT 1 NOT NULL,
	"derived_at_revision" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp with time zone,
	"invalidated_reason" text
);
--> statement-breakpoint
ALTER TABLE "mastery_checkpoint" ADD CONSTRAINT "mastery_checkpoint_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mastery_checkpoint" ADD CONSTRAINT "mastery_checkpoint_map_id_subject_map_id_fk" FOREIGN KEY ("map_id") REFERENCES "public"."subject_map"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mastery_checkpoint" ADD CONSTRAINT "mastery_checkpoint_agent_run_id_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_map" ADD CONSTRAINT "subject_map_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_map" ADD CONSTRAINT "subject_map_persona_id_agent_persona_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."agent_persona"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_map" ADD CONSTRAINT "subject_map_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_map" ADD CONSTRAINT "subject_map_mastery_run_id_agent_run_id_fk" FOREIGN KEY ("mastery_run_id") REFERENCES "public"."agent_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_map_edge" ADD CONSTRAINT "subject_map_edge_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_map_edge" ADD CONSTRAINT "subject_map_edge_map_id_subject_map_id_fk" FOREIGN KEY ("map_id") REFERENCES "public"."subject_map"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_map_node" ADD CONSTRAINT "subject_map_node_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_map_node" ADD CONSTRAINT "subject_map_node_map_id_subject_map_id_fk" FOREIGN KEY ("map_id") REFERENCES "public"."subject_map"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mastery_checkpoint_map_idx" ON "mastery_checkpoint" USING btree ("workspace_id","map_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "subject_map_unique_idx" ON "subject_map" USING btree ("workspace_id","persona_id","subject_kind","subject_ref");--> statement-breakpoint
CREATE INDEX "subject_map_persona_idx" ON "subject_map" USING btree ("workspace_id","persona_id");--> statement-breakpoint
CREATE INDEX "subject_map_repository_idx" ON "subject_map" USING btree ("workspace_id","repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subject_map_edge_live_idx" ON "subject_map_edge" USING btree ("map_id","from_key","to_key","kind") WHERE "subject_map_edge"."invalidated_at" is null;--> statement-breakpoint
CREATE INDEX "subject_map_edge_map_idx" ON "subject_map_edge" USING btree ("map_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subject_map_node_live_key_idx" ON "subject_map_node" USING btree ("map_id","key") WHERE "subject_map_node"."invalidated_at" is null;--> statement-breakpoint
CREATE INDEX "subject_map_node_map_idx" ON "subject_map_node" USING btree ("map_id","provenance");