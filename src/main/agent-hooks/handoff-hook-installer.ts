/**
 * Instalador dos hooks de handoff no filesystem do usuário.
 *
 * Os scripts (handoff-stop.mjs, handoff-deliver.mjs, soft-status.mjs) são
 * copiados do bundle para ~/.nexus/agent-hooks/ e registrados como Stop hooks
 * no ~/.claude/settings.json. Não interfere com o hook-service existente.
 *
 * Modelo: mesmo padrão dos hooks do modelo (~/.nexus/hooks/*.mjs).
 *
 * Shebang polyglot: os hooks usam um wrapper `#!/bin/sh` + linha 2 que
 * re-executa o script sob Node. A fonte mantém o placeholder literal
 * `exec process.execPath` (não-resolvível pelo shell); o installer interpola
 * o caminho absoluto do Node do Electron no momento da cópia, espelhando o
 * sidecar do Overclock (`exec '/Applications/Overclock.app/.../node' "$0"`).
 * Sem essa interpolação o shell tenta `exec` a string literal "process.execPath"
 * e emite `exec: process.execPath: not found` — hook nunca roda.
 */

import { app } from 'electron';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HANDOFF_HOOK_FILES = [
  'handoff-stop.mjs',
  'handoff-deliver.mjs',
  'soft-status.mjs',
] as const;

/**
 * Token literal no shebang polyglot da fonte. O installer o substitui pelo
 * caminho absoluto do Node do Electron em runtime. Manter como string nomeada
 * facilita o grep e o teste unitário da interpolação.
 */
const SHEBANG_NODE_PLACEHOLDER = 'exec process.execPath';

/**
 * Interpola o caminho absoluto do Node no shebang polyglot de um hook.
 * Espelha o sidecar do Overclock: `exec '/path/to/node' "$0" "$@"`.
 *
 * Puramente funcional (sem I/O nem electron) para ser unit-testável. Retorna
 * o conteúdo inalterado se o placeholder não estiver presente (hook já
 * interpolado, ou conteúdo não-polyglot).
 *
 * Em runtime do Electron empacotado, `process.execPath` é o binário do
 * Electron, não node puro — precisa ser invocado com `ELECTRON_RUN_AS_NODE=1`
 * (mesma convenção de `acp-mcp-stdio-bridge.ts:132`) para rodar um script
 * `.mjs` em vez de abrir uma janela. Quando `runAsNode === true` o shebang
 * interpolado envolve com `env ELECTRON_RUN_AS_NODE=1`.
 */
export function interpolateHookShebangNodePath(
  sourceContent: string,
  nodePath: string,
  runAsNode = false,
): string {
  if (!sourceContent.includes(SHEBANG_NODE_PLACEHOLDER)) {
    return sourceContent;
  }
  // Aspas simples + escape POSIX de aspas internas (compatível com /bin/sh).
  const quoted = `'${nodePath.replaceAll("'", "'\\''")}'`;
  const execCommand = runAsNode
    ? `exec env ELECTRON_RUN_AS_NODE=1 ${quoted}`
    : `exec ${quoted}`;
  return sourceContent.replaceAll(SHEBANG_NODE_PLACEHOLDER, execCommand);
}

/**
 * Detecta em runtime se o processo atual é o Electron (não node puro).
 * `process.versions.electron` só existe dentro do Electron; node puro não o
 * define. Usado para decidir se o shebang interpolado precisa do wrapper
 * `ELECTRON_RUN_AS_NODE=1`.
 */
function isRunningAsElectron(): boolean {
  return typeof (process.versions as { electron?: string }).electron === 'string';
}

function nexusHooksDir(home: string): string {
  return join(home, '.nexus', 'agent-hooks');
}

function claudeSettingsPath(home: string): string {
  return join(home, '.claude', 'settings.json');
}

/**
 * Copia os arquivos .mjs do bundle para ~/.nexus/agent-hooks/, interpolando
 * o caminho absoluto do Node no shebang polyglot (necessário — ver docstring
 * do módulo). Não sobrescreve se o conteúdo interpolado for idêntico ao
 * destino (evita invalidar cache e re-interpolar em cada bootstrap).
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
      const rawContent = readFileSync(src, 'utf8');
      const content = interpolateHookShebangNodePath(
        rawContent,
        process.execPath,
        isRunningAsElectron(),
      );
      if (existsSync(dest) && readFileSync(dest, 'utf8') === content) continue;
      writeFileSync(dest, content, { encoding: 'utf8', mode: 0o755 });
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
