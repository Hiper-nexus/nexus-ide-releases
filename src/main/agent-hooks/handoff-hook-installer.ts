/**
 * Instalador dos hooks de handoff no filesystem do usuário.
 *
 * Os scripts (handoff-stop.mjs, handoff-deliver.mjs, soft-status.mjs) são
 * copiados do bundle para ~/.nexus/agent-hooks/ e registrados como Stop hooks
 * no ~/.claude/settings.json. Não interfere com o hook-service existente.
 *
 * Modelo: mesmo padrão dos hooks do modelo (~/.nexus/hooks/*.mjs).
 */

import { app } from 'electron';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HANDOFF_HOOK_FILES = [
  'handoff-stop.mjs',
  'handoff-deliver.mjs',
  'soft-status.mjs',
] as const;

function nexusHooksDir(home: string): string {
  return join(home, '.nexus', 'agent-hooks');
}

function claudeSettingsPath(home: string): string {
  return join(home, '.claude', 'settings.json');
}

/**
 * Copia os arquivos .mjs do bundle para ~/.nexus/agent-hooks/.
 * Não sobrescreve se o conteúdo for idêntico (evita invalidar cache).
 */
export function installHandoffHookScripts(home = homedir()): string[] {
  const destDir = nexusHooksDir(home);
  mkdirSync(destDir, { recursive: true, mode: 0o700 });

  // No dev: __dirname aponta pra src/main/orch/hooks/.
  // No bundle: os hooks estão em resources/hooks/ ou app.asar.
  const sourceDir = app.isPackaged
    ? join(process.resourcesPath, 'hooks')
    : join(app.getAppPath(), 'src', 'main', 'orch', 'hooks');

  const installed: string[] = [];
  for (const filename of HANDOFF_HOOK_FILES) {
    const dest = join(destDir, filename);
    try {
      const src = join(sourceDir, filename);
      if (!existsSync(src)) continue;
      const content = readFileSync(src);
      if (existsSync(dest) && readFileSync(dest).equals(content)) continue;
      copyFileSync(src, dest);
      try { chmodSync(dest, 0o755); } catch { /* best-effort */ }
      installed.push(filename);
    } catch {
      // Best-effort: não bloqueia o bootstrap por causa de hook.
    }
  }
  return installed;
}

/**
 * Registra os hooks de handoff no ~/.claude/settings.json como Stop hooks
 * adicionais. Não remove hooks existentes — só adiciona os de handoff.
 */
export function registerHandoffStopHook(home = homedir()): boolean {
  const settingsPath = claudeSettingsPath(home);
  if (!existsSync(settingsPath)) return false;

  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const hooks = settings.hooks ?? {};
    const stopHooks: Array<Record<string, unknown>> = Array.isArray(hooks.Stop)
      ? hooks.Stop
      : [];

    const handoffCmd = join(nexusHooksDir(home), 'handoff-stop.mjs');
    const deliverCmd = join(nexusHooksDir(home), 'handoff-deliver.mjs');

    // Verifica se já existe um hook de handoff registrado.
    const hasHandoff = stopHooks.some((def) => {
      const cmdList = Array.isArray(def.hooks) ? def.hooks : [];
      return cmdList.some(
        (h: Record<string, unknown>) =>
          typeof h.command === 'string' &&
          (h.command.includes('handoff-stop') || h.command.includes('handoff-deliver')),
      );
    });

    if (!hasHandoff) {
      stopHooks.push({
        hooks: [
          { type: 'command', command: handoffCmd, timeout: 15000 },
          { type: 'command', command: deliverCmd, timeout: 15000 },
        ],
      });
      hooks.Stop = stopHooks;
      settings.hooks = hooks;
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      return true;
    }
  } catch {
    // Falha silenciosa — hooks não bloqueiam a missão.
  }
  return false;
}
