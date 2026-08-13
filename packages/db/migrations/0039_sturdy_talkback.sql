CREATE TABLE "colosseum_claim" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"statement" text NOT NULL,
	"original_holder_persona_id" uuid NOT NULL,
	"verdict" text DEFAULT 'unsettled' NOT NULL,
	"citation" text DEFAULT '' NOT NULL,
	"dropped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "colosseum_participant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"persona_id" uuid NOT NULL,
	"persona_name" text NOT NULL,
	"map_id" uuid,
	"model" text NOT NULL,
	"subject_ref" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "colosseum_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"repository_id" uuid,
	"purpose" text NOT NULL,
	"subject" text NOT NULL,
	"question" text NOT NULL,
	"status" text DEFAULT 'convened' NOT NULL,
	"turn_cap" integer NOT NULL,
	"spend_cap_usd" double precision,
	"distinct_subjects" integer DEFAULT 0 NOT NULL,
	"distinct_models" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"concluded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "colosseum_turn" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" integer NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"persona_id" uuid,
	"persona_name" text NOT NULL,
	"agent_run_id" uuid,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "colosseum_claim" ADD CONSTRAINT "colosseum_claim_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "colosseum_claim" ADD CONSTRAINT "colosseum_claim_session_id_colosseum_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."colosseum_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "colosseum_claim" ADD CONSTRAINT "colosseum_claim_original_holder_persona_id_agent_persona_id_fk" FOREIGN KEY ("original_holder_persona_id") REFERENCES "public"."agent_persona"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "colosseum_participant" ADD CONSTRAINT "colosseum_participant_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "colosseum_participant" ADD CONSTRAINT "colosseum_participant_session_id_colosseum_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."colosseum_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "colosseum_participant" ADD CONSTRAINT "colosseum_participant_persona_id_agent_persona_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."agent_persona"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "colosseum_participant" ADD CONSTRAINT "colosseum_participant_map_id_subject_map_id_fk" FOREIGN KEY ("map_id") REFERENCES "public"."subject_map"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "colosseum_session" ADD CONSTRAINT "colosseum_session_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "colosseum_session" ADD CONSTRAINT "colosseum_session_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "colosseum_session" ADD CONSTRAINT "colosseum_session_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "colosseum_turn" ADD CONSTRAINT "colosseum_turn_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "colosseum_turn" ADD CONSTRAINT "colosseum_turn_session_id_colosseum_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."colosseum_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "colosseum_turn" ADD CONSTRAINT "colosseum_turn_persona_id_agent_persona_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."agent_persona"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "colosseum_turn" ADD CONSTRAINT "colosseum_turn_agent_run_id_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "colosseum_claim_session_idx" ON "colosseum_claim" USING btree ("workspace_id","session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "colosseum_participant_unique_idx" ON "colosseum_participant" USING btree ("session_id","persona_id");--> statement-breakpoint
CREATE INDEX "colosseum_participant_session_idx" ON "colosseum_participant" USING btree ("workspace_id","session_id");--> statement-breakpoint
CREATE INDEX "colosseum_session_workspace_idx" ON "colosseum_session" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "colosseum_turn_seq_idx" ON "colosseum_turn" USING btree ("session_id","seq");