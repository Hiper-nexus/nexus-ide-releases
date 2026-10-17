/**
 * Ambiente PERSISTIDO DO USUÁRIO no Windows (`HKCU\Environment`).
 *
 * Por que existe: o env dos panes nasce de um allowlist FECHADO sobre o
 * `process.env` do processo principal (pty-manager.ts, ENV_ALLOWLIST). No
 * Windows esse `process.env` é congelado no boot: uma variável que o operador
 * cria ou edita no painel do Windows — ou com `setx` — vai para
 * `HKCU\Environment` e nunca aparece no `process.env` do app já aberto. Um MCP
 * declarado em `~/.claude.json` que depende de `MARGEM_MCP_READ_URL` /
 * `MARGEM_MCP_READ_TOKEN` subia sem elas e falhava, sem o operador ter como
 * descobrir. Este módulo é a fonte que preenche essa lacuna.
 *
 * Doutrina de segurança: nenhum shell, argv fixo, binário resolvido em código
 * (`%SystemRoot%\System32\reg.exe`), timeout curto, cache com TTL curto. A
 * execução vai pelo seam `execFile`, injetável — nenhum teste encosta no
 * registro real. É um *fill*: quem já está no env de destino vence, este módulo
 * nunca sobrescreve nada, e chaves de identidade/isolamento e de injeção de
 * linker são recusadas antes de qualquer merge (BLOCKED_* abaixo).
 */

import { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';

export const WINDOWS_USER_ENV_KEY = 'HKCU\\Environment';

/** TTL do cache. Curto de propósito: o operador muda a variável e o próximo
 * pane já a enxerga, sem reiniciar o Nexus. */
const DEFAULT_TTL_MS = 5_000;
const REG_QUERY_TIMEOUT_MS = 2_000;
const REG_QUERY_MAX_BUFFER = 1 << 20;
/** Teto de aninhamento na expansão de `%VAR%` (auto-referência é tratada
 * separadamente, pelo conjunto de chaves em resolução). */
const MAX_EXPANSION_DEPTH = 4;

/**
 * Prefixos recusados. Superconjunto deliberado do `isDangerousEnvKey` do
 * pty-manager (mantido lá para o env declarado por adapter): aqui a janela é
 * "o que o registro do usuário pode injetar no filho", mais ampla, então a
 * direção do erro é sempre a de recusar.
 *
 * - `DYLD_`/`LD_`: injeção de linker.
 * - `NODE_OPTIONS`: preload de código em todo filho Node do pane.
 * - `ELECTRON_`: muda o modo de execução de qualquer binário Electron
 *   descendente (`ELECTRON_RUN_AS_NODE` roda o app como Node puro).
 * - `NEXUS_`: autoridade e isolamento do próprio app (token de MCP do pane,
 *   identidade do pane, endpoint de hooks). O registro do usuário nunca
 *   escreve nesse namespace — quem grava é o Main, depois deste merge.
 */
const BLOCKED_ENV_PREFIXES = Object.freeze([
  'DYLD_',
  'LD_',
  'NODE_OPTIONS',
  'ELECTRON_',
  'NEXUS_',
] as const);

/**
 * Nomes recusados mesmo sem prefixo. São as chaves de identidade e localização
 * do usuário: elas já vêm do allowlist (via `process.env`) e o registro não
 * pode introduzi-las quando faltarem — um `HOME`/`USERPROFILE`/`SystemRoot`
 * vindo daqui mudaria qual perfil o CLI filho lê. `PATH` NÃO está aqui: o
 * caminho do usuário entra, mas por merge ADITIVO (ver `applyPathEntries`).
 */
const BLOCKED_ENV_KEYS: ReadonlySet<string> = new Set([
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'SYSTEMDRIVE',
  'ALLUSERSPROFILE',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'COMMONPROGRAMFILES',
  'PATHEXT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'SHELL',
  'USERNAME',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
]);

/** Nome de variável plausível. `ProgramFiles(x86)` é o motivo dos parênteses. */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_()]{0,127}$/u;

/** Linha de `reg query`: 4+ espaços, nome, 4+ espaços, tipo, 4+ espaços, valor. */
const REG_ROW_PATTERN = /^\s{4}(\S(?:.*?\S)?)\s{4}(REG_[A-Z_]+)\s{4}(.*)$/u;

export interface WindowsUserEnvEntry {
  readonly name: string;
  readonly type: 'REG_SZ' | 'REG_EXPAND_SZ';
  readonly value: string;
}

export interface WindowsUserEnvDeps {
  /** Plataforma efetiva (seam de teste; default `process.platform`). */
  readonly platform?: NodeJS.Platform;
  /** Execução SÍNCRONA de binário, sem shell; lança quando exit != 0. */
  readonly execFile?: (file: string, args: readonly string[]) => string;
  /** Caminho absoluto do reg.exe (seam de teste). */
  readonly regExe?: string;
  /** Relógio (seam de teste do TTL). */
  readonly now?: () => number;
  /** Base da expansão `%VAR%` (default `process.env`). */
  readonly expandBase?: NodeJS.ProcessEnv;
  readonly ttlMs?: number;
}

function depsPlatform(deps?: WindowsUserEnvDeps): NodeJS.Platform {
  return effectiveDeps(deps)?.platform ?? process.platform;
}

/**
 * Seam de teste. Existe porque `baseChildEnv()` (pty-manager) e `backendEnv()`
 * (mcp-hub) chamam o merge sem argumentos: sem isto não haveria como provar que
 * a ligação realmente entrega a variável do usuário. Sem seam o merge é no-op
 * fora do Windows — um seam esquecido nunca liga o registro real por acidente,
 * porque quem o define sempre traz o próprio `execFile`.
 */
let testDeps: WindowsUserEnvDeps | null = null;

function effectiveDeps(
  deps?: WindowsUserEnvDeps,
): WindowsUserEnvDeps | undefined {
  return deps ?? testDeps ?? undefined;
}

/** Só para teste: injeta plataforma/seam sem encostar no registro real. */
export function setWindowsUserEnvDepsForTests(
  deps: WindowsUserEnvDeps | null,
): void {
  testDeps = deps;
  cache = null;
  cacheGeneration++;
}

/** `reg.exe` do System32: caminho absoluto, nunca resolvido pelo PATH do filho. */
export function defaultWindowsRegExe(): string {
  const systemRoot =
    process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  // `path.win32` de propósito: o caminho é do Windows mesmo quando o módulo
  // roda (em teste) sobre um host POSIX.
  return path.win32.join(systemRoot, 'System32', 'reg.exe');
}

function defaultExecFile(file: string, args: readonly string[]): string {
  const stdout = execFileSync(file, [...args], {
    encoding: 'utf8',
    timeout: REG_QUERY_TIMEOUT_MS,
    maxBuffer: REG_QUERY_MAX_BUFFER,
    windowsHide: true,
    // argv fixo e sem shell: `HKCU\Environment` nunca é interpolado por cmd.
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return typeof stdout === 'string' ? stdout : String(stdout);
}

/** Chave recusada por prefixo (linker/Node/Electron) ou por nome de identidade. */
export function isBlockedWindowsUserEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (BLOCKED_ENV_KEYS.has(upper)) return true;
  return BLOCKED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

function isPathKey(key: string): boolean {
  return key.toUpperCase() === 'PATH';
}

/**
 * Lê as linhas de `reg query HKCU\Environment`. Só `REG_SZ` e `REG_EXPAND_SZ`
 * entram; `REG_DWORD`, `REG_BINARY`, `REG_MULTI_SZ` (que ocupa várias linhas) e
 * qualquer linha que não case com o formato são descartados sem reinterpretação.
 */
export function parseWindowsUserEnvQuery(
  stdout: string,
): readonly WindowsUserEnvEntry[] {
  const entries: WindowsUserEnvEntry[] = [];
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const match = REG_ROW_PATTERN.exec(rawLine);
    if (!match) continue;
    const [, name, type, value] = match;
    if (type !== 'REG_SZ' && type !== 'REG_EXPAND_SZ') continue;
    if (!ENV_NAME_PATTERN.test(name)) continue;
    entries.push({ name, type, value: value.trimEnd() });
  }
  return entries;
}

/**
 * Expande `%VAR%`. Variável desconhecida ou em ciclo fica LITERAL (mesmo
 * comportamento do `ExpandEnvironmentStrings` do Windows), nunca vira vazio —
 * um `%PATH%` não resolvido no meio de um valor é ruído visível, não um caminho
 * silenciosamente amputado.
 */
export function expandWindowsEnvValue(
  value: string,
  lookup: (name: string) => string | undefined,
  resolving: ReadonlySet<string> = new Set<string>(),
  depth: number = 0,
): string {
  if (depth >= MAX_EXPANSION_DEPTH) return value;
  return value.replace(/%([^%]+)%/gu, (match, name: string) => {
    const upper = name.toUpperCase();
    if (resolving.has(upper)) return match;
    const resolved = lookup(name);
    if (resolved === undefined) return match;
    const next = new Set(resolving);
    next.add(upper);
    return expandWindowsEnvValue(resolved, lookup, next, depth + 1);
  });
}

function expansionLookup(
  base: NodeJS.ProcessEnv,
  entries: readonly WindowsUserEnvEntry[],
): (name: string) => string | undefined {
  const index = new Map<string, string>();
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === 'string') index.set(key.toUpperCase(), value);
  }
  for (const entry of entries) {
    const upper = entry.name.toUpperCase();
    if (!index.has(upper)) index.set(upper, entry.value);
  }
  return (name) => index.get(name.toUpperCase());
}

function hasKeyCaseInsensitive(
  target: Readonly<Record<string, unknown>>,
  key: string,
): boolean {
  const upper = key.toUpperCase();
  return Object.keys(target).some((candidate) => candidate.toUpperCase() === upper);
}

/** Chave real do destino para `PATH`, preservando a grafia herdada (`Path`). */
function findKeyCaseInsensitive(
  target: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const upper = key.toUpperCase();
  return Object.keys(target).find((candidate) => candidate.toUpperCase() === upper);
}

function normalizePathEntry(dir: string): string {
  return dir.trim().replace(/[\\/]+$/u, '').toLowerCase();
}

function splitPathList(value: string): string[] {
  return value
    .split(';')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** Merge ADITIVO: acrescenta só os diretórios que ainda não estão no PATH. */
function applyPathEntries(
  target: Record<string, string | undefined>,
  registryPath: string,
): void {
  const existingKey = findKeyCaseInsensitive(target, 'PATH') ?? 'Path';
  const current = target[existingKey];
  if (current === undefined || current.trim() === '') {
    target[existingKey] = registryPath;
    return;
  }
  const seen = new Set(splitPathList(current).map(normalizePathEntry));
  const additions = splitPathList(registryPath).filter((dir) => {
    const normalized = normalizePathEntry(dir);
    if (normalized === '' || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
  if (additions.length === 0) return;
  const separator = current.endsWith(';') ? '' : ';';
  target[existingKey] = `${current}${separator}${additions.join(';')}`;
}

let cache: { readonly at: number; readonly entries: readonly WindowsUserEnvEntry[] } | null =
  null;
let refreshInFlight = false;
/** Invalida um refresh ainda em voo quando o cache é limpo (teste/reset). */
let cacheGeneration = 0;

/**
 * Revalidação fora da rota quente: `execFileSync` na Main segura o event loop
 * por dezenas de ms — e o merge roda a CADA spawn de pane/bridge MCP. Cache
 * presente mas vencido dispara este execFile assíncrono e serve o dado atual
 * em vez de travar o spawn. Só produção passa por aqui (o seam de teste tem
 * `execFile` próprio e segue síncrono e determinístico).
 */
function scheduleBackgroundRefresh(deps: WindowsUserEnvDeps | undefined): void {
  if (refreshInFlight) return;
  refreshInFlight = true;
  const generation = cacheGeneration;
  execFile(
    deps?.regExe ?? defaultWindowsRegExe(),
    ['query', WINDOWS_USER_ENV_KEY],
    {
      encoding: 'utf8',
      timeout: REG_QUERY_TIMEOUT_MS,
      maxBuffer: REG_QUERY_MAX_BUFFER,
      windowsHide: true,
    },
    (error, stdout) => {
      refreshInFlight = false;
      // Falha (sem reg.exe, política, timeout) ou cache já invalidado por um
      // reset: mantém o dado atual, nunca zera — o filho segue com o último
      // env conhecido.
      if (error || generation !== cacheGeneration) return;
      cache = { at: Date.now(), entries: parseWindowsUserEnvQuery(String(stdout)) };
    },
  );
}

/** Descarta o cache (próxima leitura vai ao registro). */
export function refreshWindowsUserEnvironment(): void {
  cache = null;
  cacheGeneration++;
}

function queryRegisteredEntries(
  deps?: WindowsUserEnvDeps,
): readonly WindowsUserEnvEntry[] {
  const exec = deps?.execFile ?? defaultExecFile;
  try {
    return parseWindowsUserEnvQuery(
      exec(deps?.regExe ?? defaultWindowsRegExe(), ['query', WINDOWS_USER_ENV_KEY]),
    );
  } catch {
    // Ambiente sem reg.exe, política restritiva ou timeout: o filho segue com
    // o que o allowlist já dava. Nunca lança para o spawn.
    return [];
  }
}

function registeredEntries(
  deps?: WindowsUserEnvDeps,
): readonly WindowsUserEnvEntry[] {
  const now = deps?.now?.() ?? Date.now();
  const ttl = deps?.ttlMs ?? DEFAULT_TTL_MS;
  if (cache && now - cache.at < ttl) return cache.entries;
  // Produção com cache vencido: revalida em background sem segurar o Main e
  // serve a leitura atual — a variável nova aparece no próximo spawn (TTL +
  // ~30 ms), nunca custa um execFileSync na Main fora da partida a frio.
  if (cache && deps?.execFile === undefined) {
    scheduleBackgroundRefresh(deps);
    return cache.entries;
  }
  const entries = queryRegisteredEntries(deps);
  cache = { at: now, entries };
  return entries;
}

/**
 * Env do usuário pronto para merge: tipado, expandido, filtrado. Chaves
 * recusadas (`isBlockedWindowsUserEnvKey`) ficam de fora; `Path`/`PATH` entra
 * como entrada normal e quem faz o merge aditivo é `mergeWindowsUserEnvironment`.
 */
export function readWindowsUserEnvironment(
  deps?: WindowsUserEnvDeps,
): Record<string, string> {
  const effective = effectiveDeps(deps);
  if (depsPlatform(effective) !== 'win32') return {};
  const entries = registeredEntries(effective);
  const lookup = expansionLookup(effective?.expandBase ?? process.env, entries);
  const out: Record<string, string> = {};
  for (const entry of entries) {
    if (isBlockedWindowsUserEnvKey(entry.name)) continue;
    const value =
      entry.type === 'REG_EXPAND_SZ'
        ? expandWindowsEnvValue(
            entry.value,
            lookup,
            new Set<string>([entry.name.toUpperCase()]),
          )
        : entry.value;
    if (value === '') continue;
    out[entry.name] = value;
  }
  return out;
}

/**
 * Preenche `target` com o env do usuário do registro. Só preenche: uma chave já
 * presente (em qualquer caixa — no Windows o nome é case-insensitive) fica como
 * está, então `process.env` e o allowlist continuam vencendo, e o
 * `suppressEnv`/`envRemove` do spawn (que roda depois) continua vencendo este
 * merge. `Path` é a exceção: merge aditivo dos diretórios novos do usuário.
 *
 * Fora do Windows é no-op — o `process.env` já carrega o ambiente do operador.
 */
export function mergeWindowsUserEnvironment(
  target: Record<string, string | undefined>,
  deps?: WindowsUserEnvDeps,
): void {
  const effective = effectiveDeps(deps);
  if (depsPlatform(effective) !== 'win32') return;
  for (const [key, value] of Object.entries(readWindowsUserEnvironment(effective))) {
    if (value === '') continue;
    if (isPathKey(key)) {
      applyPathEntries(target, value);
      continue;
    }
    if (hasKeyCaseInsensitive(target, key)) continue;
    target[key] = value;
  }
}

/** Só para teste: limpa o cache entre casos. */
export function resetWindowsUserEnvCacheForTests(): void {
  cache = null;
  cacheGeneration++;
}
