CREATE TABLE "sync_projects" (
	"account_id" uuid NOT NULL,
	"project_id" text NOT NULL,
	"revision" integer NOT NULL,
	"entities" jsonb NOT NULL,
	"entity_count" integer NOT NULL,
	"state_bytes" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_projects_pk" PRIMARY KEY("account_id","project_id"),
	CONSTRAINT "sync_projects_revision_check" CHECK ("sync_projects"."revision" > 0),
	CONSTRAINT "sync_projects_entity_count_check" CHECK ("sync_projects"."entity_count" >= 0 AND "sync_projects"."entity_count" <= 1000),
	CONSTRAINT "sync_projects_state_bytes_check" CHECK ("sync_projects"."state_bytes" >= 0 AND "sync_projects"."state_bytes" <= 196608)
);
--> statement-breakpoint
ALTER TABLE "sync_projects" ADD CONSTRAINT "sync_projects_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_projects_account_updated_idx" ON "sync_projects" USING btree ("account_id","updated_at");