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
 * Este módulo agora é o limpador idempotente daquele estado. Roda no boot;
 * falha silenciosa (best-effort) — limpeza nunca bloqueia a missão.
 *
 * Alvos (mesma regra em todos: só sai entrada que casa um vestígio conhecido
 * do port OU que aponta para um executável que não existe mais no disco):
 *
 * 1. ~/.claude/settings.json — Stop hooks apontando para
 *    ~/.nexus/agent-hooks/handoff-* (registro da 0.32.x).
 * 2. <workspace>/.codex/hooks.json — mesmo aninhamento do settings.json
 *    (hooks → evento → grupo → entrada). O Overclock registrava
 *    ~/.overclock-app/soft-status.mjs em SEIS eventos; com o app fora do
 *    disco, todo pane cuspia "hook exited with code 127" a cada ferramenta
 *    e o Codex abria o modal bloqueante de revisão de hook no boot.
 * 3. <workspace>/.agents/hooks.json — formato do Overclock: cada chave é um
 *    hook nomeado com `enabled` e as entradas SOLTAS por evento.
 * 4. $HOME dos outros CLIs — ~/.codex/hooks.json, ~/.grok/hooks.json e
 *    ~/.kimi-code/hooks.json. O porte largou o registro no $HOME de TODA CLI
 *    que ele tocava; limpar só o workspace deixava a versão de $HOME viva, e
 *    o estrago (127 por ferramenta + modal de revisão do Codex) reaparecia em
 *    qualquer missão fora do repo.
 * 5. ~/.grok/hooks/*.json — o Grok não guarda um hooks.json só: cada hook é
 *    um arquivo próprio nesse diretório. Formato não é presumido — a varredura
 *    ali é por predicado de comando (ver `pruneDeadHookCommands`).
 *
 * Todo config que fica sem nenhum hook sai do disco — é lixo do port, não
 * arquivo do usuário. Qualquer entrada que não case a regra (hook do usuário,
 * de outro produto, ou de um executável que ainda existe) permanece intocada.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** Arquivos que a 0.32.x copiava para ~/.nexus/agent-hooks/. */
export const LEGACY_HANDOFF_HOOK_FILES = [
  'handoff-stop.mjs',
  'handoff-deliver.mjs',
  'soft-status.mjs',
] as const;

/** Diretório do app Overclock — origem do port, hoje fora do disco. */
const OVERCLOCK_APP_DIR = '.overclock-app/';

/** Configs de hook que os portes largaram no workspace (não no $HOME). */
const CODEX_HOOKS_CONFIG = ['.codex', 'hooks.json'] as const;
const AGENTS_HOOKS_CONFIG = ['.agents', 'hooks.json'] as const;

/**
 * Mesmo registro, mas no $HOME de cada CLI. O Codex é o caso vivo: o
 * instalador do Nexus (`codex-hook-service.ts`) escreve nesse MESMO arquivo —
 * os comandos que ele gerencia começam com `if [ -x ... ]` (nome nu de shell,
 * não caminho), então a regra daqui nunca os julga.
 */
const CODEX_HOME_HOOKS_CONFIG = ['.codex', 'hooks.json'] as const;
const GROK_HOME_HOOKS_CONFIG = ['.grok', 'hooks.json'] as const;
const KIMI_HOME_HOOKS_CONFIG = ['.kimi-code', 'hooks.json'] as const;

/** O Grok guarda hook um-por-arquivo em ~/.grok/hooks/*.json. */
const GROK_HOOKS_DIR = ['.grok', 'hooks'] as const;

function nexusAgentHooksDir(home: string): string {
  return join(home, '.nexus', 'agent-hooks');
}

function claudeSettingsPath(home: string): string {
  return join(home, '.claude', 'settings.json');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * O comando do hook é um vestígio do port? Casa tanto o diretório do Nexus
 * (0.32.x) quanto o do Overclock, que o port copiou verbatim.
 */
function isLegacyHandoffHookCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  const normalized = command.replaceAll('\\', '/');
  if (normalized.includes('.nexus/agent-hooks/handoff-')) return true;
  return LEGACY_HANDOFF_HOOK_FILES.some((file) =>
    normalized.includes(`${OVERCLOCK_APP_DIR}${file}`),
  );
}

/** Primeiro token do comando, respeitando aspas em caminho com espaço. */
function firstCommandToken(command: string): string {
  const trimmed = command.trim();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    return end > 0 ? trimmed.slice(1, end) : trimmed.slice(1);
  }
  return trimmed.split(/\s+/)[0] ?? '';
}

/**
 * Caminho de disco que o comando executa, ou null quando quem resolve é o
 * PATH do shell (nome nu tipo `pnpm`/`other-tool`, caminho relativo). Esses
 * nunca são julgados: `statSync('pnpm')` mente, e apagar hook que funciona
 * por estar no PATH seria pior que o bug.
 */
function hookCommandPath(command: string, home: string): string | null {
  const token = firstCommandToken(command);
  if (token === '~') return home;
  if (token.startsWith('~/')) return join(home, token.slice(2));
  return isAbsolute(token) ? token : null;
}

/**
 * O comando aponta para um arquivo que não existe mais no disco? É a
 * assinatura do estrago: hook registrado apontando para
 * ~/.overclock-app/*.mjs depois que o app saiu da máquina.
 *
 * statSync em vez de existsSync de propósito: existsSync devolve false
 * também em EACCES, e apagar o hook do usuário por não conseguir lê-lo é
 * pior do que deixá-lo registrado. Só ENOENT/ENOTDIR condenam.
 */
function isMissingHookExecutable(command: unknown, home: string): boolean {
  if (typeof command !== 'string') return false;
  const target = hookCommandPath(command, home);
  if (target === null) return false;
  try {
    statSync(target);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
}

/** A entrada de hook está morta (vestígio do port ou executável ausente)? */
function isDeadHookCommand(command: unknown, home: string): boolean {
  return (
    isLegacyHandoffHookCommand(command) ||
    isMissingHookExecutable(command, home)
  );
}

function isDeadHookEntry(entry: unknown, home: string): boolean {
  if (!isPlainObject(entry)) return false;
  return isDeadHookCommand(entry.command, home);
}

/** Filtra entradas soltas (formato .agents: entrada direto no evento). */
function pruneHookEntries(
  entries: unknown[],
  home: string,
): { kept: unknown[]; removed: boolean } {
  const kept = entries.filter((entry) => !isDeadHookEntry(entry, home));
  return { kept, removed: kept.length !== entries.length };
}

/**
 * Filtra grupos `{hooks: [...]}` (formato do settings.json e do
 * .codex/hooks.json); grupo que fica sem entradas sai inteiro.
 */
function pruneHookGroups(
  groups: unknown[],
  home: string,
): { kept: unknown[]; removed: boolean } {
  let removed = false;
  const kept: unknown[] = [];
  for (const group of groups) {
    if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
      kept.push(group);
      continue;
    }
    const pruned = pruneHookEntries(group.hooks, home);
    if (!pruned.removed) {
      kept.push(group);
      continue;
    }
    removed = true;
    if (pruned.kept.length === 0) continue; // grupo vazio → sai
    kept.push({ ...group, hooks: pruned.kept });
  }
  return { kept, removed };
}

/** Lê um objeto JSON do disco; null quando ausente, ilegível ou não-objeto. */
function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Reescreve o arquivo (mesma formatação do settings.json) ou apaga se vazio. */
function writeCleanedJson(
  file: string,
  doc: Record<string, unknown>,
): boolean {
  try {
    if (Object.keys(doc).length === 0) {
      rmSync(file, { force: true });
      return true;
    }
    writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove do ~/.claude/settings.json os Stop hooks deixados pelo port.
 * Aditivo no resto: qualquer outro hook (do usuário, de outros produtos)
 * permanece intocado. Retorna true quando reescreveu o arquivo.
 */
export function removeLegacyHandoffHookRegistration(
  home = homedir(),
): boolean {
  const settingsPath = claudeSettingsPath(home);
  const settings = readJsonObject(settingsPath);
  if (!settings) return false; // ausente ou ilegível — nada a limpar

  const hooks = settings.hooks;
  if (!isPlainObject(hooks) || !Array.isArray(hooks.Stop)) return false;

  const pruned = pruneHookGroups(hooks.Stop, home);
  if (!pruned.removed) return false;

  return writeCleanedJson(settingsPath, {
    ...settings,
    hooks: { ...hooks, Stop: pruned.kept },
  });
}

/**
 * Limpa <workspace>/.codex/hooks.json — aninhamento idêntico ao do
 * settings.json, com o comando do Overclock espalhado por vários eventos.
 * Apaga o arquivo quando não sobra hook nenhum. Retorna true quando mexeu.
 */
export function cleanCodexWorkspaceHooks(
  workspace: string,
  home = homedir(),
): boolean {
  const file = join(workspace, ...CODEX_HOOKS_CONFIG);
  const doc = readJsonObject(file);
  const hooks = doc?.hooks;
  if (!doc || !isPlainObject(hooks)) return false;

  let removed = false;
  const nextHooks: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      nextHooks[event] = groups;
      continue;
    }
    const pruned = pruneHookGroups(groups, home);
    if (pruned.removed) removed = true;
    if (pruned.kept.length === 0) continue; // evento esvaziou → sai
    nextHooks[event] = pruned.kept;
  }
  if (!removed) return false;

  if (Object.keys(nextHooks).length > 0) {
    return writeCleanedJson(file, { ...doc, hooks: nextHooks });
  }
  // `hooks` era a única chave → o arquivo inteiro é lixo do port.
  const rest = { ...doc };
  delete rest.hooks;
  return writeCleanedJson(file, rest);
}

/**
 * Limpa <workspace>/.agents/hooks.json — formato do Overclock: cada chave é
 * um hook nomeado (`enabled` + entradas soltas por evento). A chave sai
 * quando perde o último evento com entrada; o arquivo sai quando não sobra
 * chave. Retorna true quando mexeu.
 */
export function cleanAgentsWorkspaceHooks(
  workspace: string,
  home = homedir(),
): boolean {
  const file = join(workspace, ...AGENTS_HOOKS_CONFIG);
  const doc = readJsonObject(file);
  if (!doc) return false;

  let removed = false;
  const nextDoc: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(doc)) {
    if (!isPlainObject(value)) {
      nextDoc[name] = value;
      continue;
    }
    const nextSections: Record<string, unknown> = {};
    let liveSections = 0;
    let removedHere = false;
    for (const [section, entries] of Object.entries(value)) {
      if (!Array.isArray(entries)) {
        nextSections[section] = entries;
        continue;
      }
      const pruned = pruneHookEntries(entries, home);
      if (pruned.removed) {
        removed = true;
        removedHere = true;
      }
      if (pruned.kept.length === 0) continue;
      nextSections[section] = pruned.kept;
      liveSections += 1;
    }
    if (removedHere && liveSections === 0) continue; // hook sem entradas → sai
    nextDoc[name] = nextSections;
  }

  if (!removed) return false;
  return writeCleanedJson(file, nextDoc);
}

/** Sentinela: o valor saiu da árvore (comando morto ou container esvaziado). */
const DROPPED = Symbol('dropped');

/**
 * Varre QUALQUER arranjo de JSON removendo comandos mortos — o mesmo
 * predicado do resto do módulo: vestígio do port OU executável ausente.
 *
 * O formato do hook de cada CLI não é presumido de propósito: o Grok grava um
 * arquivo por hook e nada garante o aninhamento do Codex. O que é universal é
 * a entrada de hook TER um `command`; quem decide se ele morreu é
 * `isDeadHookCommand`, que só condena caminho com evidência.
 *
 * Container que perde entradas e fica vazio sai junto, para o arquivo não
 * sobrar como `{"hooks":{}}`. Container que já estava vazio e não perdeu nada
 * permanece: é decisão do usuário, não sobra do port.
 */
function pruneDeadHookCommands(
  value: unknown,
  home: string,
): { value: unknown; removed: boolean } {
  if (Array.isArray(value)) {
    const kept: unknown[] = [];
    let removed = false;
    for (const item of value) {
      const pruned = pruneDeadHookCommands(item, home);
      removed = removed || pruned.removed;
      if (pruned.value !== DROPPED) kept.push(pruned.value);
    }
    if (removed && kept.length === 0) return { value: DROPPED, removed };
    return { value: kept, removed };
  }
  if (!isPlainObject(value)) return { value, removed: false };

  if (isDeadHookCommand(value.command, home)) {
    return { value: DROPPED, removed: true };
  }

  let removed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const pruned = pruneDeadHookCommands(child, home);
    removed = removed || pruned.removed;
    if (pruned.value !== DROPPED) next[key] = pruned.value;
  }
  if (removed && Object.keys(next).length === 0) {
    return { value: DROPPED, removed };
  }
  return { value: next, removed };
}

/**
 * Limpa um config de hook de formato desconhecido (o de $HOME de cada CLI).
 * Apaga o arquivo quando a árvore inteira era lixo do port. Retorna true
 * quando reescreveu ou apagou.
 */
export function cleanHooksJsonFile(file: string, home = homedir()): boolean {
  const doc = readJsonObject(file);
  if (!doc) return false;
  const pruned = pruneDeadHookCommands(doc, home);
  if (!pruned.removed) return false;
  return writeCleanedJson(file, isPlainObject(pruned.value) ? pruned.value : {});
}

/** Caminhos de config de hook no $HOME do usuário (existentes ou não). */
function homeHookConfigFiles(home: string): string[] {
  const files = [
    CODEX_HOME_HOOKS_CONFIG,
    GROK_HOME_HOOKS_CONFIG,
    KIMI_HOME_HOOKS_CONFIG,
  ].map((parts) => join(home, ...parts));

  const grokDir = join(home, ...GROK_HOOKS_DIR);
  try {
    for (const name of readdirSync(grokDir)) {
      if (name.endsWith('.json')) files.push(join(grokDir, name));
    }
  } catch {
    // sem o diretório (ou sem permissão) → não há o que varrer
  }
  return files;
}

/**
 * Limpa os configs de hook de $HOME das CLIs (~/.codex, ~/.grok, ~/.kimi-code).
 * Alvo ausente é no-op; um alvo que falha não impede os outros. Devolve os
 * caminhos reescritos ou apagados, na ordem em que foram tratados.
 */
export function cleanHomeHooksConfigs(home = homedir()): string[] {
  const cleaned: string[] = [];
  for (const file of homeHookConfigFiles(home)) {
    try {
      if (cleanHooksJsonFile(file, home)) cleaned.push(file);
    } catch {
      // best-effort: um arquivo preso não bloqueia os demais nem o boot
    }
  }
  return cleaned;
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

/**
 * Boot-time: uma chamada, idempotente, nunca lança. `cleaned` lista os
 * configs de hook — de workspace e de $HOME — reescritos ou apagados.
 */
export function cleanupLegacyHandoffHooks(
  home = homedir(),
  workspace = process.cwd(),
): { unregistered: boolean; deleted: string[]; cleaned: string[] } {
  const cleaned: string[] = [];
  const mark = (file: string) => {
    if (!cleaned.includes(file)) cleaned.push(file);
  };
  try {
    const unregistered = removeLegacyHandoffHookRegistration(home);
    if (cleanCodexWorkspaceHooks(workspace, home)) {
      mark(join(workspace, ...CODEX_HOOKS_CONFIG));
    }
    if (cleanAgentsWorkspaceHooks(workspace, home)) {
      mark(join(workspace, ...AGENTS_HOOKS_CONFIG));
    }
    // $HOME depois do workspace: quando os dois coincidem (home == workspace)
    // o arquivo já foi tratado e a segunda passada vira no-op.
    for (const file of cleanHomeHooksConfigs(home)) mark(file);
    const deleted = deleteLegacyHandoffHookScripts(home);
    return { unregistered, deleted, cleaned };
  } catch {
    return { unregistered: false, deleted: [], cleaned };
  }
}
