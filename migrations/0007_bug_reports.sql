-- NOTA DE OPERAÇÃO (01/10/2026): migração só ADITIVA (duas tabelas novas e índices; nenhuma tabela
-- existente é tocada). Aplique no D1 de produção ANTES do deploy que traz as rotas de relato de bug
-- (`wrangler d1 migrations apply DB --remote`). O Worker antigo não lê nem escreve estas tabelas, então
-- aplicá-la cedo é seguro. Ver docs/bug-reports.md.
--
-- Relatos de bug enviados pelo app desktop (FASE 1: coletar, deduplicar e triar; nada aqui executa correção).
-- O texto do relato é ENTRADA NÃO CONFIÁVEL: já chega mascarado pelo servidor (src/bugs/scrub.ts), mas
-- qualquer agente futuro tem de tratá-lo como dado, nunca como instrução.
--
-- Privacidade: o relato fica ligado à conta só por account_id (o e-mail NÃO é copiado para cá; o painel admin o
-- lê de accounts). Se a conta for apagada o relato sobrevive sem dono. O diagnóstico (diagnostics_json) só existe
-- com consentimento e é ZERADO pelo cron horário depois de diagnostics_expires_at (criação + 180 dias),
-- sem apagar o relato.

CREATE TABLE bug_reports (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 8000),
  steps TEXT CHECK (steps IS NULL OR length(steps) <= 4000),
  category TEXT NOT NULL CHECK (category IN ('crash', 'terminal', 'agents', 'license', 'billing', 'ui', 'performance', 'other')),
  impact TEXT NOT NULL CHECK (impact IN ('annoying', 'blocks_work')),
  -- A pessoa não escolhe a gravidade: nasce 'medium' e o admin ajusta na triagem.
  severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'blocker')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'triaged', 'needs_info', 'fix_proposed', 'approved', 'fixed', 'released', 'wont_fix', 'duplicate')),
  app_version TEXT NOT NULL CHECK (length(app_version) BETWEEN 1 AND 32),
  platform TEXT NOT NULL CHECK (platform IN ('darwin', 'win32', 'linux')),
  arch TEXT NOT NULL CHECK (length(arch) BETWEEN 1 AND 16),
  os_version TEXT CHECK (os_version IS NULL OR length(os_version) <= 64),
  adapter TEXT CHECK (adapter IS NULL OR length(adapter) <= 40),
  model TEXT CHECK (model IS NULL OR length(model) <= 80),
  -- Contexto sem identificação (acréscimo ao contrato original: o app já o envia em `context`).
  pane_count INTEGER CHECK (pane_count IS NULL OR pane_count BETWEEN 0 AND 64),
  mission_active INTEGER CHECK (mission_active IS NULL OR mission_active IN (0, 1)),
  diagnostics_json TEXT CHECK (diagnostics_json IS NULL OR json_valid(diagnostics_json)),
  -- sha256 hex de (título normalizado + categoria + major.minor da versão): agrupa relatos repetidos.
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  duplicate_of TEXT REFERENCES bug_reports(id) ON DELETE SET NULL,
  fix_summary TEXT CHECK (fix_summary IS NULL OR length(fix_summary) <= 2000),
  fix_pr_url TEXT CHECK (fix_pr_url IS NULL OR (length(fix_pr_url) <= 500 AND fix_pr_url LIKE 'https://%')),
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  diagnostics_expires_at INTEGER NOT NULL
) STRICT;

-- Lista do painel (filtro por status, mais novos primeiro, cursor por created_at + id) e sem filtro.
CREATE INDEX bug_reports_status_created_idx ON bug_reports(status, created_at DESC, id DESC);
CREATE INDEX bug_reports_created_idx ON bug_reports(created_at DESC, id DESC);
-- "Quantos relatos têm o mesmo fingerprint" (ocorrências).
CREATE INDEX bug_reports_fingerprint_idx ON bug_reports(fingerprint);
-- "Meus relatos" e o teto de 5 por hora por conta.
CREATE INDEX bug_reports_account_created_idx ON bug_reports(account_id, created_at DESC);
-- Limpeza horária do diagnóstico vencido: só as linhas que ainda o guardam.
CREATE INDEX bug_reports_diagnostics_expiry_idx ON bug_reports(diagnostics_expires_at) WHERE diagnostics_json IS NOT NULL;

-- Linha do tempo de cada relato (quem mudou o quê). O 'approved' registra o admin que autorizou: é o ponto de
-- autorização humana que a correção automática por agente (FASE 2) vai exigir.
CREATE TABLE bug_report_events (
  id TEXT PRIMARY KEY NOT NULL,
  report_id TEXT NOT NULL REFERENCES bug_reports(id) ON DELETE CASCADE,
  actor_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('created', 'status_changed', 'severity_changed', 'note', 'duplicate_marked', 'fix_proposed', 'approved', 'rejected', 'released')),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
) STRICT;
CREATE INDEX bug_report_events_report_idx ON bug_report_events(report_id, created_at, id);

UPDATE system_metadata SET value = '7' WHERE key = 'schema_version';
