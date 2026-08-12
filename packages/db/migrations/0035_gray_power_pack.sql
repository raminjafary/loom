CREATE TABLE "note_read_edge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"tree_run_id" uuid NOT NULL,
	"reader_run_id" uuid NOT NULL,
	"author_run_id" uuid NOT NULL,
	"read_count" integer DEFAULT 1 NOT NULL,
	"first_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "note_read_edge" ADD CONSTRAINT "note_read_edge_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_read_edge" ADD CONSTRAINT "note_read_edge_tree_run_id_agent_run_id_fk" FOREIGN KEY ("tree_run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_read_edge" ADD CONSTRAINT "note_read_edge_reader_run_id_agent_run_id_fk" FOREIGN KEY ("reader_run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_read_edge" ADD CONSTRAINT "note_read_edge_author_run_id_agent_run_id_fk" FOREIGN KEY ("author_run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "note_read_edge_pair_idx" ON "note_read_edge" USING btree ("workspace_id","reader_run_id","author_run_id");--> statement-breakpoint
CREATE INDEX "note_read_edge_tree_idx" ON "note_read_edge" USING btree ("workspace_id","tree_run_id");