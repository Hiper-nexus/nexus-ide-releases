ALTER TABLE "cron_schedules" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "cron_schedules" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "auth_codes" ADD COLUMN IF NOT EXISTS "code_challenge" text;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD COLUMN IF NOT EXISTS "code_challenge" text;