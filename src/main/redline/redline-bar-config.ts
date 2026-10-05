/**
 * Nexus Redline (Linux) — instala o módulo na barra do Omarchy.
 *
 * A barra do Omarchy (quickshell) é configurada em `~/.config/omarchy/shell.json`
 * e aceita módulos `{ "type": "command", "exec": …, "interval": … }`. Aqui mora
 * a edição desse arquivo, no mesmo desenho dos comandos do próprio Omarchy
 * (`omarchy bar …`, `omarchy-shell-config`): normaliza `version`/`bar.layout`/
 * `plugins`, grava com chaves ordenadas e 2 espaços (o `jq -S` deles) por
 * temporário + rename, e manda o shell recarregar.
 *
 * É a única parte do Redline que ESCREVE na configuração do operador, então:
 * só roda por comando explícito (`--redline-bar-install`), faz backup antes de
 * qualquer mudança, é idempotente (instalar duas vezes não muda o arquivo),
 * preserva tudo o que não é nosso (inclusive ajustes que o operador fez no
 * nosso módulo), segue symlink de dotfiles em vez de trocá-lo por arquivo, e
 * recusa arquivo ilegível, grande demais ou JSON inválido sem tocar em nada.
 */

import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { readRegularFileCapped } from './redline-safe-read';

export const REDLINE_BAR_MODULE_ID = 'nexus-redline';
export const REDLINE_BAR_INTERVAL_SECONDS = 30;
const SHELL_CONFIG_MAX_BYTES = 1024 * 1024;
const SECTIONS = ['left', 'center', 'right'] as const;
const TRAY_WIDGET_ID = 'omarchy.tray';
const OPEN_QUOTA_COMMAND = 'xdg-open nexus://quota';

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Aspas simples para `bash -lc`: o caminho do app pode ter espaço. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Chaves ordenadas (recursivo), 2 espaços e quebra final, como o `jq -S`. */
export function stableStringify(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (isObject(input)) {
      return Object.fromEntries(
        Object.keys(input)
          .sort()
          .map((key) => [key, sort(input[key])]),
      );
    }
    return input;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

/** O que a barra executa a cada `interval` segundos. */
export function redlineBarEntry(appExecutable: string): Json {
  return {
    id: REDLINE_BAR_MODULE_ID,
    type: 'command',
    exec: `${shellQuote(appExecutable)} --redline-status`,
    interval: REDLINE_BAR_INTERVAL_SECONDS,
    onClick: OPEN_QUOTA_COMMAND,
    tooltip: 'Nexus Redline',
  };
}

function entryId(entry: unknown): string {
  if (typeof entry === 'string') return entry;
  if (isObject(entry) && entry.id !== undefined && entry.id !== null) return String(entry.id);
  return '';
}

/** Mesma normalização do `omarchy-shell-config`: o resto do arquivo fica como está. */
export function normalizeShellConfig(input: unknown): Json {
  const config: Json = isObject(input) ? { ...input } : {};
  config.version = 1;
  const bar: Json = isObject(config.bar) ? { ...config.bar } : {};
  const layout: Json = isObject(bar.layout) ? { ...bar.layout } : {};
  for (const section of SECTIONS) {
    layout[section] = Array.isArray(layout[section]) ? [...(layout[section] as unknown[])] : [];
  }
  bar.layout = layout;
  config.bar = bar;
  config.plugins = Array.isArray(config.plugins) ? [...(config.plugins as unknown[])] : [];
  return config;
}

function layoutOf(config: Json): Record<(typeof SECTIONS)[number], unknown[]> {
  return (config.bar as Json).layout as Record<(typeof SECTIONS)[number], unknown[]>;
}

export type BarEditAction = 'added' | 'updated' | 'unchanged' | 'removed' | 'absent';

export interface BarEditResult {
  config: Json;
  action: BarEditAction;
}

/**
 * Põe o módulo na barra. Já existe: só corrige `type`/`exec` (o app pode ter
 * mudado de lugar) e completa o que faltar; ajustes do operador (`interval`,
 * `fontSize`…) ficam. Não existe: entra logo depois da bandeja, na direita.
 */
export function applyRedlineBarEntry(input: unknown, entry: Json): BarEditResult {
  const config = normalizeShellConfig(input);
  const layout = layoutOf(config);
  for (const section of SECTIONS) {
    const index = layout[section].findIndex((candidate) => entryId(candidate) === REDLINE_BAR_MODULE_ID);
    if (index === -1) continue;
    const current = layout[section][index];
    const base: Json = isObject(current) ? current : {};
    const merged: Json = { ...entry, ...base, id: REDLINE_BAR_MODULE_ID, type: 'command', exec: entry.exec };
    if (stableStringify(merged) === stableStringify(current)) return { config, action: 'unchanged' };
    layout[section][index] = merged;
    return { config, action: 'updated' };
  }
  const trayAt = layout.right.findIndex((candidate) => entryId(candidate) === TRAY_WIDGET_ID);
  layout.right.splice(trayAt === -1 ? 0 : trayAt + 1, 0, entry);
  return { config, action: 'added' };
}

export function removeRedlineBarEntry(input: unknown): BarEditResult {
  const config = normalizeShellConfig(input);
  const layout = layoutOf(config);
  let removed = false;
  for (const section of SECTIONS) {
    const kept = layout[section].filter((candidate) => entryId(candidate) !== REDLINE_BAR_MODULE_ID);
    if (kept.length !== layout[section].length) removed = true;
    layout[section] = kept;
  }
  return { config, action: removed ? 'removed' : 'absent' };
}

export interface RedlineBarInstallDeps {
  homedir: string;
  env: NodeJS.ProcessEnv;
  now: () => number;
  /** Manda o shell reler o arquivo. Best-effort; `true` quando respondeu. */
  reloadShell: () => boolean;
}

export type RedlineBarInstallStatus =
  | 'installed'
  | 'updated'
  | 'unchanged'
  | 'removed'
  | 'not-installed'
  | 'refused';

export interface RedlineBarInstallResult {
  status: RedlineBarInstallStatus;
  /** Frase para o operador (pt-BR). */
  message: string;
  configPath: string;
  backupPath?: string;
  reloaded?: boolean;
}

export function omarchyShellConfigPath(homedir: string): string {
  return join(homedir, '.config', 'omarchy', 'shell.json');
}

function omarchyDefaultsPath(env: NodeJS.ProcessEnv): string {
  return join(env.OMARCHY_PATH || '/usr/share/omarchy', 'config', 'omarchy', 'shell.json');
}

function refused(configPath: string, message: string): RedlineBarInstallResult {
  return { status: 'refused', configPath, message };
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function writeAtomically(target: string, text: string, mode: number, pid: number): void {
  const temp = join(dirname(target), `.shell.json.nexus-redline.${pid}.tmp`);
  try {
    writeFileSync(temp, text, { encoding: 'utf8', mode });
    chmodSync(temp, mode);
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

type Edit = (config: unknown) => BarEditResult;

function editShellConfig(
  deps: RedlineBarInstallDeps,
  edit: Edit,
  statusFor: (action: BarEditAction) => RedlineBarInstallStatus,
  messageFor: (status: RedlineBarInstallStatus, configPath: string) => string,
): RedlineBarInstallResult {
  const configPath = omarchyShellConfigPath(deps.homedir);
  const read = readRegularFileCapped(configPath, SHELL_CONFIG_MAX_BYTES);

  let source: unknown;
  let writePath = configPath;
  let mode = 0o644;
  let hadFile = false;
  if (read.kind === 'text' && read.text.trim() !== '') {
    const parsed = parseJson(read.text);
    if (!parsed.ok) {
      return refused(
        configPath,
        `O shell.json não é um JSON válido e eu não alterei nada. Corrija o arquivo (${configPath}) ou use o trecho de --redline-bar-snippet.`,
      );
    }
    source = parsed.value;
    hadFile = true;
    try {
      // Dotfiles: o shell.json costuma ser um link. Edita o ARQUIVO de verdade e o link continua link.
      writePath = realpathSync(configPath);
      mode = statSync(writePath).mode & 0o777;
    } catch {
      return refused(configPath, 'Não consegui resolver o shell.json (link quebrado?); não alterei nada.');
    }
  } else if (read.kind === 'none' && read.stamp !== 'missing') {
    return refused(
      configPath,
      `Não consegui ler o shell.json (${read.stamp.startsWith('rejected') ? 'não é um arquivo comum ou passa de 1 MiB' : 'sem permissão ou ilegível'}); não alterei nada.`,
    );
  } else {
    // Sem arquivo do operador, o Omarchy usa o padrão: parte dele, como `omarchy bar put`.
    let defaultsText: string | null = null;
    try {
      defaultsText = readFileSync(omarchyDefaultsPath(deps.env), 'utf8');
    } catch {
      defaultsText = null;
    }
    const parsed = defaultsText === null ? null : parseJson(defaultsText);
    if (parsed === null || !parsed.ok) {
      return refused(
        configPath,
        'Não achei o shell.json nem a configuração padrão do Omarchy (OMARCHY_PATH). Use o trecho de --redline-bar-snippet.',
      );
    }
    source = parsed.value;
  }

  const { config, action } = edit(source);
  const status = statusFor(action);
  if (status === 'unchanged' || status === 'not-installed') {
    return { status, configPath, message: messageFor(status, configPath) };
  }

  let backupPath: string | undefined;
  try {
    if (hadFile) {
      backupPath = `${writePath}.bak.nexus-redline.${Math.floor(deps.now() / 1000)}`;
      copyFileSync(writePath, backupPath);
      chmodSync(backupPath, 0o600);
    } else {
      mkdirSync(dirname(configPath), { recursive: true });
    }
    writeAtomically(writePath, stableStringify(config), mode, process.pid);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'erro';
    return refused(configPath, `Não consegui gravar o shell.json (${code}); o arquivo original ficou como estava.`);
  }
  const reloaded = deps.reloadShell();
  return {
    status,
    configPath,
    ...(backupPath === undefined ? {} : { backupPath }),
    reloaded,
    message: messageFor(status, configPath),
  };
}

/** `appExecutable`: caminho do app que a barra vai chamar com `--redline-status`. */
export function installRedlineBar(
  deps: RedlineBarInstallDeps,
  appExecutable: string,
): RedlineBarInstallResult {
  return editShellConfig(
    deps,
    (config) => applyRedlineBarEntry(config, redlineBarEntry(appExecutable)),
    (action) => (action === 'added' ? 'installed' : action === 'updated' ? 'updated' : 'unchanged'),
    (status) =>
      status === 'unchanged'
        ? 'O Redline já está na barra do Omarchy; não mudei nada.'
        : status === 'updated'
          ? 'O Redline já estava na barra; atualizei o comando.'
          : 'Redline adicionado à barra do Omarchy, ao lado da bandeja.',
  );
}

export function uninstallRedlineBar(deps: RedlineBarInstallDeps): RedlineBarInstallResult {
  return editShellConfig(
    deps,
    (config) => removeRedlineBarEntry(config),
    (action) => (action === 'removed' ? 'removed' : 'not-installed'),
    (status) =>
      status === 'removed'
        ? 'Redline removido da barra do Omarchy.'
        : 'O Redline não estava na barra do Omarchy; não mudei nada.',
  );
}
