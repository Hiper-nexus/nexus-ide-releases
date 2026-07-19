ALTER TABLE "cron_schedules" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cron_schedules" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "auth_codes" ADD COLUMN "code_challenge" text;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD COLUMN "code_challenge" text;