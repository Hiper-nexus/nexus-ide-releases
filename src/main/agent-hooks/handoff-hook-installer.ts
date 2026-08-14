/**
 * Limpeza dos hooks de handoff legados (0.32.x) — port decomissionado.
 *
 * Entre a 0.32.x e a substituição pelo fechamento mecânico no Main
 * (src/main/orch/turn-end-handoff.ts), este módulo INSTALAVA cópias dos
 * scripts handoff-stop.mjs / handoff-deliver.mjs / soft-status.mjs (port
 * quase verbatim do Overclock) em ~/.nexus/agent-hooks/ e os registrava
 * como Stop hooks GLOBAIS no ~/.claude/settings.json do usuário.
 *
 * O port nunca funcionou no Nexus: os scripts liam env vars que o spawn
 * não define (NEXUS_PANE_ID/NEXUS_CALLER_PANE_ID), resolviam caminhos com
 * til literal ("~/.nexus/hooks") e o endpoint MCP com o nome de servidor
 * do Overclock — saíam exit 0 para todo pane. Em build empacotado nem
 * chegavam a existir (extraResource nunca copiou "hooks"); só máquinas de
 * dev receberam os arquivos e o registro global.
 *
 * Este módulo agora é o limpador idempotente daquele estado: remove do
 * ~/.claude/settings.json qualquer hook cujo comando aponte para
 * ~/.nexus/agent-hooks/handoff-* e apaga os arquivos. Roda no boot; falha
 * silenciosa (best-effort) — limpeza nunca bloqueia a missão.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Arquivos que a 0.32.x copiava para ~/.nexus/agent-hooks/. */
export const LEGACY_HANDOFF_HOOK_FILES = [
  'handoff-stop.mjs',
  'handoff-deliver.mjs',
  'soft-status.mjs',
] as const;

function nexusAgentHooksDir(home: string): string {
  return join(home, '.nexus', 'agent-hooks');
}

function claudeSettingsPath(home: string): string {
  return join(home, '.claude', 'settings.json');
}

/** O comando do hook aponta para o nosso diretório legado de agent-hooks? */
function isLegacyHandoffHookCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  const normalized = command.replaceAll('\\', '/');
  return normalized.includes('.nexus/agent-hooks/handoff-');
}

/**
 * Remove do ~/.claude/settings.json os Stop hooks registrados pela 0.32.x.
 * Aditivo no resto: qualquer outro hook (do usuário, de outros produtos)
 * permanece intocado. Retorna true quando reescreveu o arquivo.
 */
export function removeLegacyHandoffHookRegistration(
  home = homedir(),
): boolean {
  const settingsPath = claudeSettingsPath(home);
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch {
    return false; // ausente ou ilegível — nada registrado para limpar
  }
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  const stopGroups = hooks?.Stop;
  if (!Array.isArray(stopGroups)) return false;

  let removed = false;
  const cleaned = stopGroups.filter((group) => {
    if (typeof group !== 'object' || group === null) return true;
    const entries = (group as { hooks?: unknown }).hooks;
    if (!Array.isArray(entries)) return true;
    const kept = entries.filter(
      (entry: Record<string, unknown>) =>
        !isLegacyHandoffHookCommand(entry?.command),
    );
    if (kept.length !== entries.length) removed = true;
    if (kept.length === 0) return false; // grupo ficou vazio → sai
    (group as { hooks: unknown }).hooks = kept;
    return true;
  });

  if (!removed) return false;
  (hooks as Record<string, unknown>).Stop = cleaned;
  try {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}

/**
 * Apaga os scripts legados de ~/.nexus/agent-hooks/. Retorna os nomes
 * removidos (vazio quando não havia nada — boot idempotente).
 */
export function deleteLegacyHandoffHookScripts(home = homedir()): string[] {
  const dir = nexusAgentHooksDir(home);
  const deleted: string[] = [];
  for (const filename of LEGACY_HANDOFF_HOOK_FILES) {
    const target = join(dir, filename);
    try {
      if (!existsSync(target)) continue;
      rmSync(target, { force: true });
      deleted.push(filename);
    } catch {
      // best-effort: um arquivo preso não bloqueia os demais nem o boot
    }
  }
  return deleted;
}

/** Boot-time: uma chamada, idempotente, nunca lança. */
export function cleanupLegacyHandoffHooks(
  home = homedir(),
): { unregistered: boolean; deleted: string[] } {
  try {
    const unregistered = removeLegacyHandoffHookRegistration(home);
    const deleted = deleteLegacyHandoffHookScripts(home);
    return { unregistered, deleted };
  } catch {
    return { unregistered: false, deleted: [] };
  }
}
