import type { PeriodicTaskContext } from '../observability/periodic-task';
import { execFile } from 'node:child_process';
import { isModelId } from '../../shared/model-id';
import { getEffectivePath, resolveCliBinary } from '../path-resolver';
import {
  CLI_MODEL_CACHE_SOURCES,
  cliCacheConsumerVersion,
  readCliModelCache,
  readCliModelCacheAsync,
  type CliModelCacheReadOptions,
} from './cli-model-discovery';

/**
 * Descoberta VIVA de modelos por CLI: "saiu modelo novo → aparece no Nexus"
 * sem esperar release. Cada estratégia pergunta à própria CLI instalada quais
 * modelos ela conhece (a CLI se atualiza sozinha e é a fonte de verdade do
 * provider). O resultado entra em cache com TTL e é mesclado à lista estática
 * do adapter em listProviderSettings; "Atualizar modelos" força um refresh e
 * o broadcast de providers empurra a lista nova para a UI.
 */

interface DiscoveryStrategy {
  readonly bin: string;
  readonly args: readonly string[];
  readonly parse: (stdout: string) => string[];
}

/** AGY `models` — TSV `id\\tlabel`, ou JSON `{ command.data.models[].id }`. */
export function parseAgyModelsOutput(stdout: string): string[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const fromJson = agyModelIdsFromJson(parsed);
      if (fromJson.length > 0) return fromJson;
    } catch {
      // Fall through to TSV — older CLIs print id\\tlabel on stdout.
    }
  }
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim().split(/[\t ]+/, 1)[0] ?? '')
    .filter((id) => id.length > 0);
}

function agyModelIdsFromJson(parsed: unknown): string[] {
  if (Array.isArray(parsed)) {
    return parsed.flatMap((row) => {
      if (typeof row === 'string') return [row];
      if (row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string') {
        return [(row as { id: string }).id];
      }
      return [];
    });
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const command = (parsed as { command?: { data?: { models?: unknown } } }).command;
  const models = command?.data?.models;
  if (!Array.isArray(models)) return [];
  return models.flatMap((row) =>
    row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string'
      ? [(row as { id: string }).id]
      : [],
  );
}

/** Grok `models` — bullets `- grok-4.6` / `* grok-4.5 (default)`. */
export function parseGrokModelsOutput(stdout: string): string[] {
  const ids: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const bullet = /^\s*[-*]\s+(\S+)/.exec(line);
    if (!bullet) continue;
    ids.push(bullet[1]);
  }
  return ids;
}

export function parseKimiModelsOutput(stdout: string): string[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!parsed || typeof parsed !== 'object') return [];
  const models = (parsed as { models?: Record<string, unknown> }).models;
  return models && typeof models === 'object' ? Object.keys(models) : [];
}

/** MiMo annotates each provider/model row with its context window. */
export function parseMimoModelsOutput(stdout: string): string[] {
  return stdout.split(/\r?\n/).flatMap(line => {
    const match = /^\s*(xiaomi\/[A-Za-z0-9._:/-]+)(?:\s|$)/.exec(line);
    return match ? [match[1]] : [];
  });
}

/** OpenCode `models` — one `provider/id` per line. */
export function parseOpenCodeModelsOutput(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((id) => id.length > 0);
}

/** Cursor Agent `models` — `id - Label` (header "Available models" ignored). */
export function parseCursorAgentModelsOutput(stdout: string): string[] {
  const ids: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\S+)\s+-\s+/.exec(line);
    if (match) ids.push(match[1]);
  }
  return ids;
}

/** Qoder `qodercli --list-models` — header `MODEL`, then one id per line. */
export function parseQoderModelsOutput(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((id) => id.length > 0 && id.toUpperCase() !== 'MODEL');
}

/** Prime Agent `model list` — whitespace table; column 1 is the model id. */
export function parsePrimeAgentModelsOutput(stdout: string): string[] {
  const ids: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^(provider|-)/i.test(trimmed)) continue;
    const cols = trimmed.split(/\s+/);
    if (cols.length < 2) continue;
    ids.push(cols[1]);
  }
  return ids;
}

/** OMP `models --json` — `{ models: [{ selector, id }] }`. Prefer selector. */
export function parseOmpModelsOutput(stdout: string): string[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!parsed || typeof parsed !== 'object') return [];
  const models = (parsed as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  return models.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const rec = row as { selector?: unknown; id?: unknown };
    const selector = typeof rec.selector === 'string' ? rec.selector.trim() : '';
    const id = typeof rec.id === 'string' ? rec.id.trim() : '';
    const candidate = selector || id;
    return candidate ? [candidate] : [];
  });
}

export type ModelDiscoveryKind = 'cli' | 'cache' | 'bundled';

export interface ModelDiscoveryInventoryEntry {
  readonly kind: ModelDiscoveryKind;
  /** Exact argv when kind is `cli`. */
  readonly command?: string;
  /** Why there is no live CLI listing (kind `cache` | `bundled`). */
  readonly reason?: string;
}

/**
 * CLIs do catálogo builtin + overlays em ~/.nexus/plugins/adapters.
 * kind `cli` entra no refresh automático (abertura, settings/missão, 1 h).
 * Claude/Codex/Grok: cache oficial já lido por cli-model-discovery — sem
 * spawn do binário. `grok models` faz silent refresh do token a cada
 * invocação (~10 min no poll antigo de 5 min + TTL 5 min).
 * Sem listagem: lista bundled do adapter + enrich do catálogo; não fingimos.
 */
export const MODEL_DISCOVERY_INVENTORY: Readonly<
  Record<string, ModelDiscoveryInventoryEntry>
> = Object.freeze({
  agy: { kind: 'cli', command: 'agy models' },
  grok: {
    kind: 'cache',
    reason:
      'nunca spawna `grok models` (silent refresh do token); usa ~/.grok/models_cache.json + bundled',
  },
  kimi: { kind: 'cli', command: 'kimi provider list --json' },
  opencode: { kind: 'cli', command: 'opencode models' },
  'mimo-code': { kind: 'cli', command: 'mimo --pure models xiaomi' },
  'cursor-agent': { kind: 'cli', command: 'cursor-agent models' },
  qoder: { kind: 'cli', command: 'qodercli --list-models' },
  'prime-agent': { kind: 'cli', command: 'prime-agent model list' },
  omp: { kind: 'cli', command: 'omp models --json' },
  claude: {
    kind: 'cache',
    reason: 'sem subcomando list; usa ~/.claude/models_cache.json + bundled',
  },
  openclaude: {
    kind: 'cache',
    reason:
      'sem subcomando list; usa ~/.openclaude/models_cache.json + bundled',
  },
  codex: {
    kind: 'cache',
    reason: 'sem subcomando list; usa ~/.codex/models_cache.json + bundled',
  },
  aider: {
    kind: 'bundled',
    reason: '--list-models é busca litellm (exige filtro), não catálogo da CLI',
  },
  glm: {
    kind: 'bundled',
    reason: 'wrapper da CLI claude + endpoint z.ai; listar claude traria ids errados',
  },
  'glm-flash': {
    kind: 'bundled',
    reason: 'wrapper da CLI claude + endpoint z.ai; listar claude traria ids errados',
  },
  longcat: {
    kind: 'bundled',
    reason: 'wrapper da CLI claude + endpoint LongCat; sem catálogo próprio',
  },
  deepseek: {
    kind: 'bundled',
    reason: 'wrapper da CLI claude + endpoint DeepSeek; sem catálogo próprio',
  },
  qwen: {
    kind: 'cache',
    reason:
      'sem subcomando list; usa modelProviders do ~/.qwen/settings.json + bundled',
  },
  muse: {
    kind: 'bundled',
    reason: 'Muse não expõe comando de listar modelos',
  },
  sakana: {
    kind: 'bundled',
    reason: 'codex-fugu (wrapper Codex) sem subcomando models',
  },
});

const STRATEGIES: Readonly<Record<string, DiscoveryStrategy>> = Object.freeze({
  agy: {
    bin: 'agy',
    args: ['models'],
    parse: parseAgyModelsOutput,
  },
  kimi: {
    bin: 'kimi',
    args: ['provider', 'list', '--json'],
    parse: parseKimiModelsOutput,
  },
  'mimo-code': { bin: 'mimo', args: ['--pure', 'models', 'xiaomi'], parse: parseMimoModelsOutput },
  opencode: {
    bin: 'opencode',
    args: ['models'],
    parse: parseOpenCodeModelsOutput,
  },
  'cursor-agent': {
    bin: 'cursor-agent',
    args: ['models'],
    parse: parseCursorAgentModelsOutput,
  },
  qoder: {
    bin: 'qodercli',
    args: ['--list-models'],
    parse: parseQoderModelsOutput,
  },
  'prime-agent': {
    bin: 'prime-agent',
    args: ['model', 'list'],
    parse: parsePrimeAgentModelsOutput,
  },
  omp: {
    bin: 'omp',
    args: ['models', '--json'],
    parse: parseOmpModelsOutput,
  },
});

/** In-memory freshness for a successful live listing or cache hydrate. */
export const MODEL_DISCOVERY_TTL_MS = 60 * 60_000;
/**
 * Periodic re-ask / cache re-read. Combined with TTL_MS=5 min this used to
 * spawn `grok models` every ~10 min (interval still saw a fresh cache). Floor
 * is 1 h; grok never execs the binary even then.
 */
export const MODEL_DISCOVERY_POLL_MS = 60 * 60_000;
const TTL_MS = MODEL_DISCOVERY_TTL_MS;
const FAILURE_TTL_MS = 60_000;
/** Qoder/OMP listagens reais passam de 8s em máquina fria. */
const EXEC_TIMEOUT_MS = 15_000;
/** Cursor Agent ~200 ids; OMP ~275. Cap alto o bastante para não esconder modelo novo. */
export const MODEL_DISCOVERY_CAP = 256;
const MAX_MODELS = MODEL_DISCOVERY_CAP;
interface CacheEntry {
  readonly models: readonly string[];
  readonly fetchedAt: number;
  readonly failed: boolean;
  /** Present only when the source declared producer-version metadata. */
  readonly consumerVersion?: string | null;
}

let discoveryEpoch = 0;
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<void>>();

/** Adapters whose official `models_cache.json` is the listing — never a CLI exec. */
const CACHE_HYDRATE_ADAPTERS: ReadonlySet<string> = new Set(['grok']);

export function supportsModelDiscovery(adapterId: string): boolean {
  return adapterId in STRATEGIES || CACHE_HYDRATE_ADAPTERS.has(adapterId);
}

/** True only when refresh will `execFile` the provider binary. */
export function usesCliExecForModelDiscovery(adapterId: string): boolean {
  return adapterId in STRATEGIES;
}

export function modelsFromOfficialCliCache(files: readonly string[], options: CliModelCacheReadOptions = {}): string[] {
  return sanitizeDiscoveredModels(
    files.flatMap((file) => readCliModelCache(file, options)),
  );
}

function officialCacheFiles(adapterId: string): readonly string[] {
  return (
    CLI_MODEL_CACHE_SOURCES.find((source) => source.adapterId === adapterId)
      ?.files ?? []
  );
}

/** Leitura síncrona do cache — usada na montagem de listProviderSettings. */
export function discoveredModelsFor(adapterId: string): readonly string[] {
  const entry = cache.get(adapterId);
  if (entry && 'consumerVersion' in entry &&
      entry.consumerVersion !== (cliCacheConsumerVersion(adapterId) ?? null)) {
    cache.delete(adapterId);
    void refreshDiscoveredModels(adapterId, { force: true }).catch(() => undefined);
    return [];
  }
  return entry?.models ?? [];
}

export function sanitizeDiscoveredModels(raw: readonly string[]): string[] {
  const unique: string[] = [];
  for (const id of raw) {
    if (typeof id !== 'string') continue;
    const trimmed = id.trim();
    if (!isModelId(trimmed)) continue;
    if (unique.includes(trimmed)) continue;
    unique.push(trimmed);
    if (unique.length >= MAX_MODELS) break;
  }
  return unique;
}

function isFresh(entry: CacheEntry | undefined, now: number): boolean {
  if (!entry) return false;
  const ttl = entry.failed ? FAILURE_TTL_MS : TTL_MS;
  return now - entry.fetchedAt < ttl;
}

function execDiscovery(strategy: DiscoveryStrategy): Promise<string[]> {
  return new Promise((resolve, reject) => {
    // npm-installed CLIs are `.cmd` shims on Windows. Resolve the same
    // absolute executable used by the provider registry and let Node invoke
    // the native command interpreter for that shim; a bare `agy`/`kimi` with
    // shell:false becomes `spawn <name> ENOENT` in the packaged app.
    const command = resolveCliBinary(strategy.bin)?.binPath ?? strategy.bin;
    execFile(
      command,
      [...strategy.args],
      {
        encoding: 'utf8',
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, PATH: getEffectivePath() },
        ...(process.platform === 'win32'
          ? { shell: true, windowsHide: true }
          : {}),
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          resolve(sanitizeDiscoveredModels(strategy.parse(stdout)));
        } catch (parseError) {
          reject(
            parseError instanceof Error
              ? parseError
              : new Error(String(parseError)),
          );
        }
      },
    );
  });
}

async function hydrateFromOfficialCache(
  adapterId: string,
  options: { force?: boolean; cacheFiles?: readonly string[] } = {},
): Promise<void> {
  const now = Date.now();
  if (!options.force && isFresh(cache.get(adapterId), now)) {
    return Promise.resolve();
  }
  const files = options.cacheFiles ?? officialCacheFiles(adapterId);
  let producerChecked = false;
  let consumerVersion: string | null = null;
  const epoch = discoveryEpoch;
  const models: string[] = [];
  for (const file of files) models.push(...await readCliModelCacheAsync(file, {
    clientVersion: () => {
      producerChecked = true;
      consumerVersion = cliCacheConsumerVersion(adapterId) ?? null;
      return consumerVersion;
    },
  }));
  if (epoch !== discoveryEpoch || (producerChecked && consumerVersion !== (cliCacheConsumerVersion(adapterId) ?? null))) return;
  cache.set(adapterId, {
    models: sanitizeDiscoveredModels(models),
    fetchedAt: Date.now(),
    failed: models.length === 0,
    ...(producerChecked ? { consumerVersion } : {}),
  });
  return Promise.resolve();
}

/**
 * Atualiza o cache de um adapter (dedupe de chamadas concorrentes; falha vira
 * cache vazio com TTL curto — a CLI pode estar deslogada ou sem o comando).
 * Grok never execs `grok models`: that CLI silently rotates the refresh token.
 */
export function refreshDiscoveredModels(
  adapterId: string,
  options: {
    force?: boolean;
    /** Test seam: official cache paths without touching $HOME. */
    cacheFiles?: readonly string[];
  } = {},
): Promise<void> {
  const running = inFlight.get(adapterId);
  if (running) return running;
  if (CACHE_HYDRATE_ADAPTERS.has(adapterId)) {
    const task = hydrateFromOfficialCache(adapterId, options).finally(() => {
      if (inFlight.get(adapterId) === task) inFlight.delete(adapterId);
    });
    inFlight.set(adapterId, task);
    return task;
  }
  const strategy = STRATEGIES[adapterId];
  if (!strategy) return Promise.resolve();
  const now = Date.now();
  if (!options.force && isFresh(cache.get(adapterId), now)) {
    return Promise.resolve();
  }
  const epoch = discoveryEpoch;
  const task = execDiscovery(strategy)
    .then((models) => {
      if (discoveryEpoch !== epoch) return;
      cache.set(adapterId, { models, fetchedAt: Date.now(), failed: false });
    })
    .catch(() => {
      if (discoveryEpoch !== epoch) return;
      cache.set(adapterId, {
        models: cache.get(adapterId)?.models ?? [],
        fetchedAt: Date.now(),
        failed: true,
      });
    })
    .finally(() => {
      if (inFlight.get(adapterId) === task) inFlight.delete(adapterId);
    });
  inFlight.set(adapterId, task);
  return task;
}

/**
 * Dispara descoberta para vários adapters e chama onSettled quando TODAS
 * terminarem (para o chamador re-broadcastar a lista de providers).
 */
export async function refreshAllDiscoveredModels(
  adapterIds: readonly string[],
  onSettled?: () => void,
  context?: PeriodicTaskContext,
): Promise<void> {
  for (const id of adapterIds) {
    await context?.checkpoint();
    if (!supportsModelDiscovery(id)) continue;
    await refreshDiscoveredModels(id);
    context?.assertCurrent();
  }
  onSettled?.();
}

export function resetModelDiscoveryForTests(): void {
  discoveryEpoch++;
  cache.clear();
  inFlight.clear();
}
