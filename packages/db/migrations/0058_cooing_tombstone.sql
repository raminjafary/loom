CREATE TABLE "persona_variant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"set_id" uuid NOT NULL,
	"persona_id" uuid NOT NULL,
	"markdown_source" text NOT NULL,
	"rationale" text DEFAULT '' NOT NULL,
	"position" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "persona_variant_set" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"persona_id" uuid NOT NULL,
	"proposed_by_run_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"promoted_variant_id" uuid,
	"settled_at" timestamp with time zone,
	"settled_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "variant_use" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"set_id" uuid NOT NULL,
	"variant_id" uuid,
	"agent_run_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "persona_variant" ADD CONSTRAINT "persona_variant_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_variant" ADD CONSTRAINT "persona_variant_set_id_persona_variant_set_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."persona_variant_set"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_variant" ADD CONSTRAINT "persona_variant_persona_id_agent_persona_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."agent_persona"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_variant_set" ADD CONSTRAINT "persona_variant_set_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_variant_set" ADD CONSTRAINT "persona_variant_set_persona_id_agent_persona_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."agent_persona"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_variant_set" ADD CONSTRAINT "persona_variant_set_proposed_by_run_id_agent_run_id_fk" FOREIGN KEY ("proposed_by_run_id") REFERENCES "public"."agent_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_use" ADD CONSTRAINT "variant_use_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_use" ADD CONSTRAINT "variant_use_set_id_persona_variant_set_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."persona_variant_set"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_use" ADD CONSTRAINT "variant_use_variant_id_persona_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."persona_variant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_use" ADD CONSTRAINT "variant_use_agent_run_id_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "persona_variant_set_idx" ON "persona_variant" USING btree ("workspace_id","set_id");--> statement-breakpoint
CREATE UNIQUE INDEX "persona_variant_set_open_idx" ON "persona_variant_set" USING btree ("persona_id") WHERE "persona_variant_set"."status" = 'open';--> statement-breakpoint
CREATE INDEX "persona_variant_set_workspace_idx" ON "persona_variant_set" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "variant_use_run_idx" ON "variant_use" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "variant_use_set_idx" ON "variant_use" USING btree ("workspace_id","set_id");