-- Converte updated_at para timestamptz SÓ se ainda estiver naive. Idempotente:
-- re-rodar num ambiente onde o SQL antigo já foi aplicado à mão (coluna já
-- timestamptz) vira no-op, evitando reinterpretar valores com o TimeZone da
-- sessão (o USING interpreta os timestamps naive como UTC de forma determinística).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'cron_schedules' AND column_name = 'updated_at'
      AND data_type = 'timestamp without time zone'
  ) THEN
    ALTER TABLE "cron_schedules" ALTER COLUMN "updated_at"
      SET DATA TYPE timestamp with time zone
      USING "updated_at" AT TIME ZONE 'UTC';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "cron_schedules" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "auth_codes" ADD COLUMN IF NOT EXISTS "code_challenge" text;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD COLUMN IF NOT EXISTS "code_challenge" text;