CREATE TABLE "persona_lesson" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"persona_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"authored_by_run_id" uuid,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp with time zone,
	"invalidated_reason" text
);
--> statement-breakpoint
CREATE TABLE "persona_lesson_citation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"lesson_id" uuid NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "persona_lesson" ADD CONSTRAINT "persona_lesson_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_lesson" ADD CONSTRAINT "persona_lesson_persona_id_agent_persona_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."agent_persona"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_lesson" ADD CONSTRAINT "persona_lesson_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_lesson" ADD CONSTRAINT "persona_lesson_authored_by_run_id_agent_run_id_fk" FOREIGN KEY ("authored_by_run_id") REFERENCES "public"."agent_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_lesson_citation" ADD CONSTRAINT "persona_lesson_citation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_lesson_citation" ADD CONSTRAINT "persona_lesson_citation_lesson_id_persona_lesson_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."persona_lesson"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_lesson_citation" ADD CONSTRAINT "persona_lesson_citation_agent_run_id_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "persona_lesson_live_key_idx" ON "persona_lesson" USING btree ("persona_id","repository_id","key") WHERE "persona_lesson"."invalidated_at" is null;--> statement-breakpoint
CREATE INDEX "persona_lesson_scope_idx" ON "persona_lesson" USING btree ("workspace_id","persona_id","repository_id");--> statement-breakpoint
CREATE INDEX "persona_lesson_repository_idx" ON "persona_lesson" USING btree ("workspace_id","repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "persona_lesson_citation_unique_idx" ON "persona_lesson_citation" USING btree ("lesson_id","agent_run_id");--> statement-breakpoint
CREATE INDEX "persona_lesson_citation_lesson_idx" ON "persona_lesson_citation" USING btree ("workspace_id","lesson_id");