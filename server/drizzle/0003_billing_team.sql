CREATE TYPE "public"."owner_type" AS ENUM('account', 'team');--> statement-breakpoint
CREATE TYPE "public"."team_role" AS ENUM('owner', 'member');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "teams_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."team_members" (
	"team_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"role" "public"."team_role" NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "team_members_pk" UNIQUE("team_id","account_id"),
	CONSTRAINT "team_members_one_team_per_account" UNIQUE("account_id"),
	CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade,
	CONSTRAINT "team_members_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."team_invites" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"code_prefix" text NOT NULL,
	"team_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"max_uses" integer DEFAULT 10 NOT NULL,
	"used_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp NOT NULL,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "team_invites_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade,
	CONSTRAINT "team_invites_created_by_accounts_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_type" "public"."owner_type" NOT NULL,
	"account_id" uuid,
	"team_id" uuid,
	"stripe_subscription_id" text NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"plan" "public"."plan" NOT NULL,
	"status" text NOT NULL,
	"seats" integer DEFAULT 1 NOT NULL,
	"current_period_end" timestamp,
	"grace_until" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id"),
	CONSTRAINT "subscriptions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade,
	CONSTRAINT "subscriptions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."stripe_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"processed_at" timestamp,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "teams_owner_account_id_idx" ON "public"."teams" USING btree ("owner_account_id");--> statement-breakpoint
CREATE INDEX "team_members_team_id_idx" ON "public"."team_members" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "team_members_account_id_idx" ON "public"."team_members" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "team_invites_team_id_idx" ON "public"."team_invites" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "team_invites_created_by_idx" ON "public"."team_invites" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "subscriptions_account_id_idx" ON "public"."subscriptions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "subscriptions_team_id_idx" ON "public"."subscriptions" USING btree ("team_id");
