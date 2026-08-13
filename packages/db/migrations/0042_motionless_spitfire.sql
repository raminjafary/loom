CREATE TABLE "expertise_use_node" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"use_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"map_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "expertise_use_node" ADD CONSTRAINT "expertise_use_node_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expertise_use_node" ADD CONSTRAINT "expertise_use_node_use_id_expertise_use_id_fk" FOREIGN KEY ("use_id") REFERENCES "public"."expertise_use"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expertise_use_node" ADD CONSTRAINT "expertise_use_node_node_id_subject_map_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."subject_map_node"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expertise_use_node" ADD CONSTRAINT "expertise_use_node_map_id_subject_map_id_fk" FOREIGN KEY ("map_id") REFERENCES "public"."subject_map"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expertise_use_node_unique_idx" ON "expertise_use_node" USING btree ("use_id","node_id");--> statement-breakpoint
CREATE INDEX "expertise_use_node_map_idx" ON "expertise_use_node" USING btree ("workspace_id","map_id","node_id");