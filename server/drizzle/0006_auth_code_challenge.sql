ALTER TABLE "auth_codes" ADD COLUMN IF NOT EXISTS "code_challenge" text;
ALTER TABLE "oauth_states" ADD COLUMN IF NOT EXISTS "code_challenge" text;