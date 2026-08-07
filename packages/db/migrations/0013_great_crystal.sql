CREATE TABLE "notification_target" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"transport" text NOT NULL,
	"endpoint" text NOT NULL,
	"credentials" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_target" ADD CONSTRAINT "notification_target_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_target_workspace_idx" ON "notification_target" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_target_endpoint_idx" ON "notification_target" USING btree ("workspace_id","endpoint");