CREATE TABLE "replay_campaign" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"persona_id" uuid NOT NULL,
	"replay_set_id" uuid NOT NULL,
	"label" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"cap_usd" double precision,
	"opened_by_user_id" text,
	"halt_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "replay_campaign_arm" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"revision_id" uuid,
	"markdown_source" text NOT NULL,
	"label" text NOT NULL,
	"model" text
);
--> statement-breakpoint
CREATE TABLE "replay_campaign_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"arm_id" uuid NOT NULL,
	"replay_item_id" uuid NOT NULL,
	"claimed_at" timestamp with time zone,
	"agent_run_id" uuid,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"model" text,
	"cost_usd" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "replay_campaign" ADD CONSTRAINT "replay_campaign_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_campaign" ADD CONSTRAINT "replay_campaign_persona_id_agent_persona_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."agent_persona"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_campaign" ADD CONSTRAINT "replay_campaign_replay_set_id_replay_set_id_fk" FOREIGN KEY ("replay_set_id") REFERENCES "public"."replay_set"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_campaign_arm" ADD CONSTRAINT "replay_campaign_arm_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_campaign_arm" ADD CONSTRAINT "replay_campaign_arm_campaign_id_replay_campaign_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."replay_campaign"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_campaign_arm" ADD CONSTRAINT "replay_campaign_arm_revision_id_persona_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."persona_revision"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_campaign_run" ADD CONSTRAINT "replay_campaign_run_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_campaign_run" ADD CONSTRAINT "replay_campaign_run_arm_id_replay_campaign_arm_id_fk" FOREIGN KEY ("arm_id") REFERENCES "public"."replay_campaign_arm"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_campaign_run" ADD CONSTRAINT "replay_campaign_run_replay_item_id_replay_item_id_fk" FOREIGN KEY ("replay_item_id") REFERENCES "public"."replay_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_campaign_run" ADD CONSTRAINT "replay_campaign_run_agent_run_id_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "replay_campaign_workspace_idx" ON "replay_campaign" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "replay_campaign_running_idx" ON "replay_campaign" USING btree ("persona_id") WHERE "replay_campaign"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "replay_campaign_arm_position_idx" ON "replay_campaign_arm" USING btree ("campaign_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "replay_campaign_run_item_idx" ON "replay_campaign_run" USING btree ("arm_id","replay_item_id");--> statement-breakpoint
CREATE INDEX "replay_campaign_run_workspace_idx" ON "replay_campaign_run" USING btree ("workspace_id","created_at");