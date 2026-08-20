ALTER TABLE "persona_proposer_session" ADD COLUMN "source" text DEFAULT 'failure-record' NOT NULL;--> statement-breakpoint
ALTER TABLE "persona_proposer_session" ADD COLUMN "divergent_runs_shown" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "persona_proposer_session" ADD COLUMN "sibling_refusals_shown" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "persona_proposer_session" ADD COLUMN "sibling_refusals_withheld" integer DEFAULT 0 NOT NULL;