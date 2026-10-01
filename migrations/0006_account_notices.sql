-- NOTA DE OPERAÇÃO (01/10/2026): aplique esta migração no D1 de produção ANTES de ligar os avisos
-- por e-mail (`wrangler d1 migrations apply DB --remote`). Com EMAIL_ENABLED="false" o Worker não
-- lê nem escreve estas estruturas, então aplicá-la cedo é seguro. Contas que já existem entram
-- com os avisos LIGADOS (notices_opt_out = 0): quem não quiser usa o link de descadastro de cada e-mail.
-- Avisos por e-mail da conta (boas-vindas e fim do teste). Uma linha por (conta, tipo) é o que
-- impede o mesmo aviso de sair duas vezes: o despacho só marca depois de o Resend aceitar o envio.
-- O endereço de e-mail NÃO é guardado aqui (ele já vive em accounts); provider_id é só o id do
-- envio no Resend, para conciliar com o painel deles.

CREATE TABLE account_notices (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('welcome', 'trial_ending_3d', 'trial_ending_1d', 'trial_ended')),
  sent_at INTEGER NOT NULL CHECK (sent_at >= 0),
  provider_id TEXT CHECK (provider_id IS NULL OR length(provider_id) <= 100),
  PRIMARY KEY (account_id, kind)
) STRICT, WITHOUT ROWID;

-- 1 = a pessoa saiu da lista pelo link de descadastro (LGPD). Vale para todos os tipos.
ALTER TABLE accounts ADD COLUMN notices_opt_out INTEGER NOT NULL DEFAULT 0 CHECK (notices_opt_out IN (0, 1));

-- A consulta horária do despacho filtra por fim de teste e por criação da conta.
CREATE INDEX accounts_trial_expires_idx ON accounts(trial_expires_at) WHERE trial_expires_at IS NOT NULL;
CREATE INDEX accounts_created_idx ON accounts(created_at);

-- Nova ação auditada: o envio de teste do painel admin. SQLite não altera CHECK inline, então a
-- tabela é reconstruída preservando as linhas (mesmo método da 0005).
CREATE TABLE admin_audit_v3 (
  id TEXT PRIMARY KEY NOT NULL,
  actor_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  target_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('suspend', 'resume', 'extend_trial', 'mint_license_code', 'revoke_license_code', 'test_notice')),
  details TEXT NOT NULL CHECK (json_valid(details)),
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
) STRICT;
INSERT INTO admin_audit_v3(id, actor_account_id, target_account_id, action, details, created_at)
  SELECT id, actor_account_id, target_account_id, action, details, created_at FROM admin_audit;
DROP TABLE admin_audit;
ALTER TABLE admin_audit_v3 RENAME TO admin_audit;
CREATE INDEX admin_audit_actor_created_idx ON admin_audit(actor_account_id, created_at);
CREATE INDEX admin_audit_target_created_idx ON admin_audit(target_account_id, created_at);
CREATE INDEX admin_audit_created_idx ON admin_audit(created_at);

UPDATE system_metadata SET value = '6' WHERE key = 'schema_version';
