ALTER TABLE "colosseum_session" ADD COLUMN "speaking_run_id" uuid;--> statement-breakpoint
ALTER TABLE "colosseum_session" ADD COLUMN "speaking_persona_id" uuid;--> statement-breakpoint
ALTER TABLE "colosseum_session" ADD CONSTRAINT "colosseum_session_speaking_run_id_agent_run_id_fk" FOREIGN KEY ("speaking_run_id") REFERENCES "public"."agent_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "colosseum_session" ADD CONSTRAINT "colosseum_session_speaking_persona_id_agent_persona_id_fk" FOREIGN KEY ("speaking_persona_id") REFERENCES "public"."agent_persona"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "colosseum_session_speaking_idx" ON "colosseum_session" USING btree ("workspace_id","speaking_run_id");