CREATE TABLE "cron_leases" (
	"account_id" uuid NOT NULL,
	"project_id" text NOT NULL,
	"schedule_id" text NOT NULL,
	"occurrence_at" bigint NOT NULL,
	"token_hash" text,
	"version" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cron_leases_pk" PRIMARY KEY("account_id","project_id","schedule_id","occurrence_at"),
	CONSTRAINT "cron_leases_version_check" CHECK ("cron_leases"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "cron_schedules" (
	"account_id" uuid NOT NULL,
	"project_id" text NOT NULL,
	"schedule_id" text NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"definition_hash" text NOT NULL,
	"status" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "cron_schedules_pk" PRIMARY KEY("account_id","project_id","schedule_id"),
	CONSTRAINT "cron_schedules_version_check" CHECK ("cron_schedules"."version" > 0),
	CONSTRAINT "cron_schedules_status_check" CHECK ("cron_schedules"."status" IN ('active', 'paused', 'deleted'))
);
--> statement-breakpoint
ALTER TABLE "cron_leases" ADD CONSTRAINT "cron_leases_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cron_schedules" ADD CONSTRAINT "cron_schedules_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cron_leases_expiry_idx" ON "cron_leases" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "cron_schedules_project_status_idx" ON "cron_schedules" USING btree ("account_id","project_id","status");