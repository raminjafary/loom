CREATE TABLE "channel_read" (
	"workspace_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"last_read_seq" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_read" ADD CONSTRAINT "channel_read_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_read" ADD CONSTRAINT "channel_read_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_read_key_idx" ON "channel_read" USING btree ("workspace_id","channel_id","user_id");