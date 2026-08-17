ALTER TABLE "persona_variant_set" ADD COLUMN "verifier_run_id" uuid;--> statement-breakpoint
ALTER TABLE "persona_variant_set" ADD COLUMN "verifier_picked_variant_id" uuid;--> statement-breakpoint
ALTER TABLE "persona_variant_set" ADD COLUMN "verifier_reason" text;--> statement-breakpoint
ALTER TABLE "persona_variant_set" ADD COLUMN "verifier_decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "persona_variant_set" ADD CONSTRAINT "persona_variant_set_verifier_run_id_agent_run_id_fk" FOREIGN KEY ("verifier_run_id") REFERENCES "public"."agent_run"("id") ON DELETE set null ON UPDATE no action;