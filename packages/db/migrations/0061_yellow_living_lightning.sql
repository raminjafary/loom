CREATE TABLE "replay_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"replay_set_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"source_run_id" uuid,
	"repository_id" uuid NOT NULL,
	"commit_sha" text NOT NULL,
	"task" text NOT NULL,
	"observed_outcome" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replay_set" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"persona_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"considered" integer NOT NULL,
	"eligible" integer NOT NULL,
	"detail" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "variant_screen" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"set_id" uuid NOT NULL,
	"replay_set_id" uuid NOT NULL,
	"variant_id" uuid,
	"decision" text,
	"reason" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "variant_screen_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"screen_id" uuid NOT NULL,
	"replay_item_id" uuid NOT NULL,
	"claimed_at" timestamp with time zone,
	"agent_run_id" uuid,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "replay_item" ADD CONSTRAINT "replay_item_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_item" ADD CONSTRAINT "replay_item_replay_set_id_replay_set_id_fk" FOREIGN KEY ("replay_set_id") REFERENCES "public"."replay_set"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_item" ADD CONSTRAINT "replay_item_source_run_id_agent_run_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."agent_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_item" ADD CONSTRAINT "replay_item_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_set" ADD CONSTRAINT "replay_set_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_set" ADD CONSTRAINT "replay_set_persona_id_agent_persona_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."agent_persona"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_screen" ADD CONSTRAINT "variant_screen_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_screen" ADD CONSTRAINT "variant_screen_set_id_persona_variant_set_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."persona_variant_set"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_screen" ADD CONSTRAINT "variant_screen_replay_set_id_replay_set_id_fk" FOREIGN KEY ("replay_set_id") REFERENCES "public"."replay_set"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_screen" ADD CONSTRAINT "variant_screen_variant_id_persona_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."persona_variant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_screen_run" ADD CONSTRAINT "variant_screen_run_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_screen_run" ADD CONSTRAINT "variant_screen_run_screen_id_variant_screen_id_fk" FOREIGN KEY ("screen_id") REFERENCES "public"."variant_screen"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_screen_run" ADD CONSTRAINT "variant_screen_run_replay_item_id_replay_item_id_fk" FOREIGN KEY ("replay_item_id") REFERENCES "public"."replay_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_screen_run" ADD CONSTRAINT "variant_screen_run_agent_run_id_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "replay_item_position_idx" ON "replay_item" USING btree ("replay_set_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "replay_set_version_idx" ON "replay_set" USING btree ("persona_id","version");--> statement-breakpoint
CREATE INDEX "replay_set_workspace_idx" ON "replay_set" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "variant_screen_arm_idx" ON "variant_screen" USING btree ("set_id","variant_id") WHERE "variant_screen"."variant_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "variant_screen_incumbent_idx" ON "variant_screen" USING btree ("set_id") WHERE "variant_screen"."variant_id" is null;--> statement-breakpoint
CREATE INDEX "variant_screen_workspace_idx" ON "variant_screen" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "variant_screen_run_item_idx" ON "variant_screen_run" USING btree ("screen_id","replay_item_id");--> statement-breakpoint
CREATE INDEX "variant_screen_run_workspace_idx" ON "variant_screen_run" USING btree ("workspace_id","created_at");