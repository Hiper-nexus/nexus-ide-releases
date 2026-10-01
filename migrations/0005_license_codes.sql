-- Códigos de licença resgatáveis no app ("tenho um código").
-- A coluna code_hash guarda sha256 do código normalizado — nunca o plaintext.
-- A concessão materializa uma linha em `subscriptions` com
-- stripe_subscription_id = 'codegrant:<code_id>:<account_id>', então todo o
-- caminho de entitlement/licença existente vale sem exceções.

CREATE TABLE license_codes (
  id TEXT PRIMARY KEY NOT NULL,
  code_hash TEXT NOT NULL UNIQUE CHECK (length(code_hash) = 64),
  -- Últimos 4 caracteres visíveis para o admin reconhecer o código na lista.
  code_suffix TEXT NOT NULL CHECK (length(code_suffix) = 4),
  plan TEXT NOT NULL CHECK (plan IN ('pro')),
  -- NULL = licença perpétua (concessão sem expiração administrável por período).
  period_days INTEGER CHECK (period_days IS NULL OR (period_days >= 1 AND period_days <= 36500)),
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses >= 1 AND max_uses <= 100),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 200),
  created_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
) STRICT;
CREATE INDEX license_codes_created_idx ON license_codes(created_at);

-- Um resgate por (código, conta); o CAP de usos é imposto atomicamente pelo
-- INSERT...SELECT com COUNT em license-codes.ts — batch é transação no D1.
CREATE TABLE license_redemptions (
  code_id TEXT NOT NULL REFERENCES license_codes(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  redeemed_at INTEGER NOT NULL,
  PRIMARY KEY (code_id, account_id)
) STRICT;
CREATE INDEX license_redemptions_account_idx ON license_redemptions(account_id);

-- Novas ações auditadas: mint/revoke de código de licença. SQLite não altera
-- CHECK inline, então a tabela é reconstruída preservando as linhas.
CREATE TABLE admin_audit_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  actor_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  target_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('suspend', 'resume', 'extend_trial', 'mint_license_code', 'revoke_license_code')),
  details TEXT NOT NULL CHECK (json_valid(details)),
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
) STRICT;
INSERT INTO admin_audit_v2(id, actor_account_id, target_account_id, action, details, created_at)
  SELECT id, actor_account_id, target_account_id, action, details, created_at FROM admin_audit;
DROP TABLE admin_audit;
ALTER TABLE admin_audit_v2 RENAME TO admin_audit;
CREATE INDEX admin_audit_actor_created_idx ON admin_audit(actor_account_id, created_at);
CREATE INDEX admin_audit_target_created_idx ON admin_audit(target_account_id, created_at);
CREATE INDEX admin_audit_created_idx ON admin_audit(created_at);

UPDATE system_metadata SET value = '5' WHERE key = 'schema_version';
